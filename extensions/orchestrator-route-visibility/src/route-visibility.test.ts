import type {
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "openclaw/plugin-sdk/types";
import { describe, expect, it } from "vitest";
import {
  OrchestratorRouteStore,
  buildOrchestratorRouteRecord,
  formatRouteStatus,
  parseOneApiRouteMetadata,
  parseOneApiRoutingEvent,
} from "./route-visibility.js";

function started(overrides: Partial<PluginHookModelCallStartedEvent> = {}) {
  return {
    runId: "run-1",
    callId: "call-1",
    provider: "oneapi",
    model: "auto-v0",
    requestedModel: "auto-v0",
    ...overrides,
  } satisfies PluginHookModelCallStartedEvent;
}

function ended(overrides: Partial<PluginHookModelCallEndedEvent> = {}) {
  return {
    ...started(),
    durationMs: 42,
    outcome: "completed",
    providerResponseHeaders: {
      "x-oneapi-request-id": "oneapi-1",
      "x-oneapi-correlation-id": "run-1",
      "x-oneapi-routing-schema-version": "1",
      "x-oneapi-requested-model": "auto-v0",
      "x-oneapi-resolved-model": "meta-llama/test",
      "x-oneapi-provider-family": "groq",
      "x-oneapi-fallback-used": "false",
      "x-oneapi-attempts": "1",
      "x-oneapi-latency-ms": "17.5",
      "x-oneapi-runtime-build-id": "build-1",
    },
    ...overrides,
  } satisfies PluginHookModelCallEndedEvent;
}

describe("orchestrator route visibility", () => {
  it("parses only the safe OneAPI header allowlist", () => {
    expect(
      parseOneApiRouteMetadata({
        "x-oneapi-request-id": "request-1",
        "x-oneapi-resolved-model": "model-1",
        "x-oneapi-fallback-used": "true",
        "x-oneapi-attempts": "2",
        "x-oneapi-latency-ms": "12.5",
        authorization: "Bearer should-never-appear",
        "x-api-key": "secret",
      }),
    ).toEqual({
      requestId: "request-1",
      resolvedModel: "model-1",
      fallbackUsed: true,
      attempts: 2,
      latencyMs: 12.5,
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("keeps OpenClaw and OneAPI fallback layers separate (%s/%s)", (openclaw, oneapi) => {
    const record = buildOrchestratorRouteRecord({
      started: {
        sequence: 1,
        role: "orchestrator",
        event: started({ fallbackActive: openclaw }),
      },
      ended: ended({
        fallbackActive: openclaw,
        providerResponseHeaders: {
          "x-oneapi-fallback-used": String(oneapi),
        },
      }),
    });
    expect(record.openclawFallbackUsed).toBe(openclaw);
    expect(record.oneapi.fallbackUsed).toBe(oneapi);
  });

  it("keeps request records separate and labels continuation calls", () => {
    const store = new OrchestratorRouteStore();
    store.start(started());
    store.end(ended());
    store.start(started({ callId: "call-2" }));
    const second = store.end(ended({ callId: "call-2" }));

    expect(second?.role).toBe("orchestrator_continuation");
    expect(second?.sequence).toBe(2);
    expect(store.trace("run-1").map((record) => record.callId)).toEqual(["call-1", "call-2"]);
  });

  it("consumes only safe fields from the existing routing-event lookup", () => {
    expect(
      parseOneApiRoutingEvent({
        schema_version: 1,
        oneapi_request_id: "oneapi-lookup-1",
        correlation_id: "run-1",
        requested_model: "auto-v0",
        resolved_model: "deepseek-v4-flash-free",
        provider_family: "opencode_zen",
        fallback_used: true,
        fallback_reason: "upstream_error",
        attempts: 2,
        latency_ms: 123,
        runtime_build_id: "oneapi-build-1",
        outcome: "success",
        authorization: "Bearer must-not-appear",
      }),
    ).toEqual({
      schemaVersion: "1",
      requestId: "oneapi-lookup-1",
      correlationId: "run-1",
      requestedModel: "auto-v0",
      resolvedModel: "deepseek-v4-flash-free",
      providerFamily: "opencode_zen",
      fallbackUsed: true,
      fallbackReason: "upstream_error",
      attempts: 2,
      latencyMs: 123,
      runtimeBuildId: "oneapi-build-1",
      outcome: "success",
    });
  });

  it("formats last resolved route as historical diagnostic state", () => {
    const text = formatRouteStatus({
      config: {
        agents: {
          defaults: { model: { primary: "oneapi/auto-v0" } },
          entries: { "telegram-router": { model: { primary: "oneapi/fast" } } },
        },
      },
      agentId: "telegram-router",
      sessionKey: "agent:telegram-router:telegram:direct:1",
      latest: buildOrchestratorRouteRecord({
        started: { sequence: 1, role: "orchestrator", event: started() },
        ended: ended(),
      }),
    });
    expect(text).toContain("configured global intent: oneapi/auto-v0");
    expect(text).toContain("agent primary (telegram-router): oneapi/fast");
    expect(text).toContain("last OneAPI resolved model: meta-llama/test");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("should-never-appear");
  });
});
