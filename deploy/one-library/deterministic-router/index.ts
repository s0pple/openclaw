import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  extractKnowledgeTitle,
  isKnowledgeContentQuestion,
  renderKnowledgeToolResult,
} from "./knowledge.js";

const KNOWLEDGE_AGENT_ID = "telegram-router";
const knowledgeContextBySession = new Map();
const KNOWLEDGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const KNOWLEDGE_CONTEXT_MAX = 256;

function sessionKnowledgeContext(sessionKey) {
  if (!sessionKey) return undefined;
  const current = knowledgeContextBySession.get(sessionKey);
  if (!current || Date.now() - current.updatedAt > KNOWLEDGE_CONTEXT_TTL_MS) {
    knowledgeContextBySession.delete(sessionKey);
    return undefined;
  }
  return current;
}

function rememberKnowledgeContext(sessionKey, title) {
  if (!sessionKey) return;
  knowledgeContextBySession.set(sessionKey, {
    ...(title ? { title } : {}),
    updatedAt: Date.now(),
  });
  if (knowledgeContextBySession.size <= KNOWLEDGE_CONTEXT_MAX) return;
  const oldest = [...knowledgeContextBySession.entries()].toSorted(
    ([, left], [, right]) => left.updatedAt - right.updatedAt,
  )[0]?.[0];
  if (oldest) knowledgeContextBySession.delete(oldest);
}

function terminalRuntimeFailure() {
  return {
    handled: true,
    reply: {
      text: "OneLibrary returned status: retrieval_unavailable. I cannot answer this book-content question without validated evidence, and I will not use model memory or another source.",
    },
    reason: "knowledge-tool-enforcement-failed-closed",
  };
}

export default definePluginEntry({
  id: "deterministic-router",
  name: "Deterministic Router",
  register(api) {
    api.on("before_agent_reply", async (event, context) => {
      if (context.agentId !== KNOWLEDGE_AGENT_ID) return;
      const sessionKey = context.sessionKey || context.sessionId;
      const previous = sessionKnowledgeContext(sessionKey);
      const question = String(event.cleanedBody || "").trim();
      if (!isKnowledgeContentQuestion(question, { hasKnowledgeContext: Boolean(previous) })) {
        return;
      }

      const title = extractKnowledgeTitle(question) || previous?.title;
      rememberKnowledgeContext(sessionKey, title);

      const mcp = api.runtime.mcp;
      if (!mcp || !context.sessionId || !context.workspaceDir) {
        return terminalRuntimeFailure();
      }

      try {
        const result = await mcp.callTool({
          sessionId: context.sessionId,
          ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
          workspaceDir: context.workspaceDir,
          agentId: context.agentId,
          serverName: "onelibrary",
          toolName: "ask_book",
          input: {
            question,
            ...(title ? { title } : {}),
          },
          ...(context.senderId ? { requesterSenderId: context.senderId } : {}),
          ...(context.accountId ? { agentAccountId: context.accountId } : {}),
          ...(context.messageProvider ? { messageChannel: context.messageProvider } : {}),
        });
        return {
          handled: true,
          reply: { text: renderKnowledgeToolResult(result) },
          reason: "knowledge-tool-enforced",
        };
      } catch {
        return terminalRuntimeFailure();
      }
    }, { eligibleTriggers: ["user"], priority: 200 });

    api.on("before_model_resolve", (event, context) => {
      if (context.agentId !== "telegram-router") return;
      // OneAPI is the central router. Keep an explicit /fast escape hatch for
      // short local-only replies, but do not classify ordinary turns here.
      // This lets OneAPI choose between Groq, browser proxies, OpenCode and
      // other configured providers using its current routing policy.
      if (/^\/(fast|local)\b/i.test(String(event.prompt || "").trim())) {
        return { providerOverride: "ollama", modelOverride: "qwen3.5:4b" };
      }
      return { providerOverride: "oneapi", modelOverride: "auto-v0" };
    }, { priority: 100 });
  },
});
