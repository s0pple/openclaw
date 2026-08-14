import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  formatRouteStatus,
  lookupOneApiRoutingEvent,
  OrchestratorRouteStore,
} from "./src/route-visibility.js";

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
      const logRecord = (observed: typeof record) => {
        api.logger.info?.(
          `[orchestrator-route] ${JSON.stringify({
            role: observed.role,
            sequence: observed.sequence,
            runId: observed.runId,
            callId: observed.callId,
            sessionKey: observed.sessionKey,
            selectedCandidate: observed.selectedCandidate,
            requestedModel: observed.requestedModel,
            openclawFallbackUsed: observed.openclawFallbackUsed,
            openclawFallbackReason: observed.openclawFallbackReason,
            oneapi: observed.oneapi,
            responseModel: observed.responseModel,
            outcome: observed.outcome,
            responseStatus: observed.responseStatus,
            durationMs: observed.durationMs,
          })}`,
        );
      };
      const requestId = record.oneapi.requestId;
      if (!requestId) {
        logRecord(record);
        return;
      }
      void lookupOneApiRoutingEvent(api.runtime.config.current(), requestId).then((metadata) => {
        logRecord(
          metadata ? (store.enrich(record.runId, record.callId, metadata) ?? record) : record,
        );
      });
    });

    api.registerCommand({
      name: "route-status",
      description: "Show safe OpenClaw orchestrator and last OneAPI route diagnostics",
      requireAuth: true,
      handler: (ctx) => {
        const session = ctx.sessionKey
          ? api.runtime.agent.session.getSessionEntry({
              sessionKey: ctx.sessionKey,
              readConsistency: "latest",
            })
          : undefined;
        return {
          text: formatRouteStatus({
            config: api.runtime.config.current(),
            agentId: ctx.agentId,
            session,
            sessionKey: ctx.sessionKey,
            latest: store.latest(ctx.sessionKey),
          }),
        };
      },
    });
  },
});
