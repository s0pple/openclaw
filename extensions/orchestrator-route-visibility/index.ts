import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { OrchestratorRouteStore, formatRouteStatus } from "./src/route-visibility.js";

export default definePluginEntry({
  id: "orchestrator-route-visibility",
  name: "Orchestrator Route Visibility",
  description: "Shows safe OpenClaw and OneAPI model-route diagnostics without changing routing.",
  register(api: OpenClawPluginApi) {
    const store = new OrchestratorRouteStore();

    api.on("model_call_started", (event) => {
      store.start(event);
    });

    api.on("model_call_ended", (event) => {
      const record = store.end(event);
      if (!record) {
        return;
      }
      api.logger.info?.(
        `[orchestrator-route] ${JSON.stringify({
          role: record.role,
          sequence: record.sequence,
          runId: record.runId,
          callId: record.callId,
          sessionKey: record.sessionKey,
          selectedCandidate: record.selectedCandidate,
          requestedModel: record.requestedModel,
          openclawFallbackUsed: record.openclawFallbackUsed,
          openclawFallbackReason: record.openclawFallbackReason,
          oneapi: record.oneapi,
          responseModel: record.responseModel,
          outcome: record.outcome,
          responseStatus: record.responseStatus,
          durationMs: record.durationMs,
        })}`,
      );
    });

    api.registerCommand({
      name: "route-status",
      description: "Show safe OpenClaw orchestrator and last OneAPI route diagnostics",
      requireAuth: true,
      handler: (ctx) => {
        const session = ctx.sessionKey
          ? api.runtime.agent.session.getSessionEntry({
              sessionKey: ctx.sessionKey,
            })
          : undefined;
        const agentId = ctx.sessionKey ? parseAgentSessionKey(ctx.sessionKey)?.agentId : undefined;
        return {
          text: formatRouteStatus({
            config: api.runtime.config.current(),
            agentId,
            session,
            sessionKey: ctx.sessionKey,
            latest: store.latest(ctx.sessionKey),
          }),
        };
      },
    });
  },
});
