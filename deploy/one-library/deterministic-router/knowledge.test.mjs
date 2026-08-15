import assert from "node:assert/strict";
import {
  extractKnowledgeTitle,
  isKnowledgeContentQuestion,
  renderKnowledgeToolResult,
} from "./knowledge.js";

assert.equal(isKnowledgeContentQuestion("Who is Sunny in Shadow Slave?"), true);
assert.equal(isKnowledgeContentQuestion("Wer ist Sunny in Shadow Slave?"), true);
assert.equal(isKnowledgeContentQuestion("Which powers does Sunny have?"), true);
assert.equal(isKnowledgeContentQuestion("Hat Sunny in Shadow Slave einen Bruder?"), true);
assert.equal(isKnowledgeContentQuestion("Wie weit bin ich bei Shadow Slave?"), false);
assert.equal(isKnowledgeContentQuestion("Wo kann ich Shadow Slave weiterlesen?"), false);
assert.equal(isKnowledgeContentQuestion("What is SQLite?"), false);
assert.equal(
  isKnowledgeContentQuestion("And what powers does he have?", { hasKnowledgeContext: true }),
  true,
);
assert.equal(extractKnowledgeTitle("Who is Sunny in Shadow Slave?"), "Shadow Slave");
assert.equal(
  extractKnowledgeTitle(
    "Was weiß ich bis zu meinem aktuellen Lesestand über Sunny in Shadow Slave?",
  ),
  "Shadow Slave",
);
assert.equal(
  extractKnowledgeTitle("Was passiert in Shadow Slave in Kapitel 2200?"),
  "Shadow Slave",
);

const answered = renderKnowledgeToolResult({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        status: "answered",
        answer: "Grounded answer.",
        citations: [{ chapter_number: 15, source_ref: "Shadow Slave#chapter:15" }],
      }),
    },
  ],
});
assert.match(answered, /Grounded answer/);
assert.match(answered, /Chapter 15/);

for (const status of [
  "insufficient_evidence",
  "missing_confirmed_progress",
  "needs_item_disambiguation",
  "boundary_exceeds_confirmed_progress",
  "model_unavailable",
  "retrieval_unavailable",
  "citation_validation_failed",
]) {
  assert.match(
    renderKnowledgeToolResult({
      content: [{ type: "text", text: JSON.stringify({ status }) }],
    }),
    new RegExp(`status: ${status}`),
  );
}

assert.match(
  renderKnowledgeToolResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "answered", answer: "unsafe", citations: [] }),
      },
    ],
  }),
  /citation_validation_failed/,
);

console.log("knowledge enforcement checks passed");
