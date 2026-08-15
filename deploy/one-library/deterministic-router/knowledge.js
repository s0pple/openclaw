const TERMINAL_STATUSES = new Set([
  "insufficient_evidence",
  "missing_confirmed_progress",
  "needs_item_disambiguation",
  "boundary_exceeds_confirmed_progress",
  "model_unavailable",
  "retrieval_unavailable",
  "citation_validation_failed",
]);

const PROGRESS_PATTERN =
  /\b(?:progress|current\s+chapter|reading\s+progress|lesestand|lesefortschritt|wie\s+weit\s+bin\s+ich|welches\s+kapitel\s+bin\s+ich|zuletzt\s+gelesen)\b/i;
const SOURCE_PATTERN =
  /\b(?:where\s+(?:can|do)\s+i\s+(?:read|continue)|continue\s+reading|wo\s+(?:kann|soll)\s+ich\s+(?:weiter)?lesen|quelle|source)\b/i;
const STRONG_CONTENT_PATTERN =
  /\b(?:abilit(?:y|ies)|powers?|aspects?|brother|sister|mother|father|relationship|relationships|character|characters|event|events|plot|lore|world|faction|factions|location|locations|backstory|spell|bruder|schwester|kräfte|faehigkeiten|fähigkeiten|beziehung|beziehungen|figur|figuren|ereignis|ereignisse|handlung|welt|fraktion|ort|orte|hintergrundgeschichte|geschichte|wer\s+ist|was\s+passiert|was\s+weiß\s+ich|was\s+weiss\s+ich|welche\s+kräfte|welche\s+faehigkeiten|welche\s+fähigkeiten|hat\s+.+\s+(?:einen?\s+)?bruder|hat\s+.+\s+(?:eine?\s+)?schwester)\b/i;
const BROAD_CONTENT_PATTERN =
  /\b(?:who\s+is|what\s+is|what\s+happened|what\s+do\s+i\s+know|explain|wer\s+ist|was\s+ist|was\s+passiert|erkläre|erklaere|erklären|erlaeutere)\b/i;
const BOOK_CONTEXT_PATTERN =
  /\b(?:book|novel|series|story|chapter|chapters|volume|buch|roman|serie|geschichte|kapitel|band)\b/i;

function hasNonInitialCapitalizedWord(text) {
  const words = String(text || "").match(/\b[\p{Lu}][\p{L}\d'’-]{2,}\b/gu) ?? [];
  return words.length > 0;
}

export function extractKnowledgeTitle(prompt) {
  const text = String(prompt || "").trim();
  const matches = [
    ...text.matchAll(
      /\b(?:in|from|of|about|on|über|ueber|aus|zu)\s+([\p{Lu}][\p{L}\d'’-]*(?:\s+[\p{Lu}][\p{L}\d'’-]*){0,5})/gu,
    ),
  ];
  // Prefer the last explicit title-like phrase. This handles questions such
  // as "what do I know about Sunny in Shadow Slave?" without mistaking the
  // character for the book title.
  for (const match of matches.toReversed()) {
    const title = match[1]?.trim();
    if (
      title &&
      !/^(?:chapter|kapitel|volume|band)(?:\s+\d+)?$/i.test(title)
    ) {
      return title;
    }
  }
  return undefined;
}

export function isKnowledgeContentQuestion(prompt, options = {}) {
  const text = String(prompt || "").trim();
  if (!text || PROGRESS_PATTERN.test(text) || SOURCE_PATTERN.test(text)) {
    return false;
  }
  const strongContent = STRONG_CONTENT_PATTERN.test(text);
  const broadContent = BROAD_CONTENT_PATTERN.test(text);
  const bookContext = BOOK_CONTEXT_PATTERN.test(text) || Boolean(extractKnowledgeTitle(text));
  const priorKnowledgeContext = options.hasKnowledgeContext === true;

  // Conservative routing is intentional: a possible book-content question
  // must not be left available for an ungrounded model-prior answer.
  if (strongContent) {
    return true;
  }
  if (priorKnowledgeContext && broadContent) {
    return true;
  }
  return bookContext && broadContent && hasNonInitialCapitalizedWord(text);
}

function parseToolPayload(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result;
  if (record.isError === true) {
    return undefined;
  }
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const textBlock = content.find(
    (entry) => entry && typeof entry === "object" && entry.type === "text" && typeof entry.text === "string",
  );
  if (!textBlock) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(textBlock.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function terminalText(status) {
  const normalized = typeof status === "string" && status.trim() ? status.trim() : "retrieval_unavailable";
  return `OneLibrary returned status: ${normalized}. I cannot answer this book-content question without validated evidence, and I will not use model memory or another source.`;
}

export function renderKnowledgeToolResult(result) {
  const payload = parseToolPayload(result);
  const status = payload?.status;
  if (status !== "answered") {
    return terminalText(TERMINAL_STATUSES.has(status) ? status : status);
  }
  const answer = typeof payload.answer === "string" ? payload.answer.trim() : "";
  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  const safeCitations = citations
    .map((citation) => {
      if (!citation || typeof citation !== "object") return undefined;
      const chapter = citation.chapter_number;
      const source = typeof citation.source_ref === "string" ? citation.source_ref : undefined;
      if (typeof chapter === "number" && Number.isFinite(chapter)) {
        return source ? `Chapter ${chapter} (${source})` : `Chapter ${chapter}`;
      }
      return source;
    })
    .filter(Boolean);
  if (!answer || safeCitations.length === 0) {
    return terminalText("citation_validation_failed");
  }
  return `${answer}\n\nCitations: ${safeCitations.join(", ")}`;
}

export const KNOWLEDGE_TERMINAL_STATUSES = [...TERMINAL_STATUSES];
