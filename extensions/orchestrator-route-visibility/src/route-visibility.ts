import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "openclaw/plugin-sdk/types";

const MAX_TRACKED_CALLS = 256;
const ROUTING_LOOKUP_TIMEOUT_MS = 1500;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SAFE_FALLBACK_REASONS = new Set([
  "no_active_keys",
  "rate_limited",
  "route_unavailable",
  "provider_unavailable",
  "upstream_error",
  "timeout",
  "policy_fallback",
]);
const SAFE_OUTCOMES = new Set([
  "success",
  "no_active_keys",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "upstream_error",
  "client_disconnected",
  "invalid_model",
  "all_routes_exhausted",
  "auth_failed",
  "invalid_request",
  "invalid_policy",
  "route_unavailable",
  "internal_error",
]);

export type OneApiRouteMetadata = {
  schemaVersion?: string;
  requestId?: string;
  correlationId?: string;
  requestedModel?: string;
  resolvedModel?: string;
  providerFamily?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  attempts?: number;
  latencyMs?: number;
  runtimeBuildId?: string;
  outcome?: string;
};

export type OrchestratorRouteRecord = {
  role: "orchestrator" | "orchestrator_continuation";
  sequence: number;
  runId: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  selectedCandidate: string;
  requestedModel?: string;
  openclawFallbackUsed?: boolean;
  openclawFallbackReason?: string;
  oneapi: OneApiRouteMetadata;
  responseModel?: string;
  outcome: "completed" | "error";
  responseStatus?: number;
  durationMs: number;
};

type StartedCall = {
  sequence: number;
  role: OrchestratorRouteRecord["role"];
  event: PluginHookModelCallStartedEvent;
};

const HEADER_FIELDS = {
  schemaVersion: "x-oneapi-routing-schema-version",
  requestId: "x-oneapi-request-id",
  correlationId: "x-oneapi-correlation-id",
  requestedModel: "x-oneapi-requested-model",
  resolvedModel: "x-oneapi-resolved-model",
  providerFamily: "x-oneapi-provider-family",
  fallbackUsed: "x-oneapi-fallback-used",
  fallbackReason: "x-oneapi-fallback-reason",
  attempts: "x-oneapi-attempts",
  latencyMs: "x-oneapi-latency-ms",
  runtimeBuildId: "x-oneapi-runtime-build-id",
  outcome: "x-oneapi-outcome",
} as const;

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (!text || text.length > 160 || text.includes("://")) {
    return undefined;
  }
  if (/authorization|credential|secret|token/i.test(text)) {
    return undefined;
  }
  return /^[A-Za-z0-9._:/@+~-]+$/u.test(text) ? text : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function finiteMilliseconds(value: string | undefined): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanHeader(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

export function parseOneApiRouteMetadata(
  headers: Readonly<Record<string, string>> | undefined,
): OneApiRouteMetadata {
  const read = (field: keyof typeof HEADER_FIELDS): string | undefined =>
    nonEmpty(headers?.[HEADER_FIELDS[field]]);
  return {
    ...(read("schemaVersion") ? { schemaVersion: read("schemaVersion") } : {}),
    ...(read("requestId") ? { requestId: read("requestId") } : {}),
    ...(read("correlationId") ? { correlationId: read("correlationId") } : {}),
    ...(read("requestedModel") ? { requestedModel: read("requestedModel") } : {}),
    ...(read("resolvedModel") ? { resolvedModel: read("resolvedModel") } : {}),
    ...(read("providerFamily") ? { providerFamily: read("providerFamily") } : {}),
    ...(booleanHeader(read("fallbackUsed")) !== undefined
      ? { fallbackUsed: booleanHeader(read("fallbackUsed")) }
      : {}),
    ...(read("fallbackReason") ? { fallbackReason: read("fallbackReason") } : {}),
    ...(finiteInteger(read("attempts")) !== undefined
      ? { attempts: finiteInteger(read("attempts")) }
      : {}),
    ...(finiteMilliseconds(read("latencyMs")) !== undefined
      ? { latencyMs: finiteMilliseconds(read("latencyMs")) }
      : {}),
    ...(read("runtimeBuildId") ? { runtimeBuildId: read("runtimeBuildId") } : {}),
    ...(read("outcome") ? { outcome: read("outcome") } : {}),
  };
}

/** Parse the existing authenticated OneAPI routing-event response without trusting extra fields. */
export function parseOneApiRoutingEvent(payload: unknown): OneApiRouteMetadata | undefined {
  const root = record(payload);
  const event = record(root?.event) ?? root;
  if (!event) {
    return undefined;
  }
  const requestId = safeIdentifier(event.oneapi_request_id);
  if (!requestId) {
    return undefined;
  }
  const schemaVersion = event.schema_version === 1 ? "1" : undefined;
  const attempts =
    typeof event.attempts === "number" &&
    Number.isSafeInteger(event.attempts) &&
    event.attempts >= 0
      ? event.attempts
      : Array.isArray(event.attempts)
        ? event.attempts.length
        : undefined;
  const fallbackReason = safeIdentifier(event.fallback_reason);
  const outcome = safeIdentifier(event.outcome);
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    requestId,
    ...(safeIdentifier(event.correlation_id)
      ? { correlationId: safeIdentifier(event.correlation_id) }
      : {}),
    ...(safeIdentifier(event.requested_model)
      ? { requestedModel: safeIdentifier(event.requested_model) }
      : {}),
    ...(safeIdentifier(event.resolved_model)
      ? { resolvedModel: safeIdentifier(event.resolved_model) }
      : {}),
    ...(safeIdentifier(event.provider_family)
      ? { providerFamily: safeIdentifier(event.provider_family) }
      : {}),
    ...(typeof event.fallback_used === "boolean" ? { fallbackUsed: event.fallback_used } : {}),
    ...(fallbackReason && SAFE_FALLBACK_REASONS.has(fallbackReason) ? { fallbackReason } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(typeof event.latency_ms === "number" &&
    Number.isFinite(event.latency_ms) &&
    event.latency_ms >= 0
      ? { latencyMs: event.latency_ms }
      : {}),
    ...(safeIdentifier(event.runtime_build_id)
      ? { runtimeBuildId: safeIdentifier(event.runtime_build_id) }
      : {}),
    ...(outcome && SAFE_OUTCOMES.has(outcome) ? { outcome } : {}),
  };
}

function mergeOneApiRouteMetadata(
  current: OneApiRouteMetadata,
  update: OneApiRouteMetadata,
): OneApiRouteMetadata {
  return {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
  } as OneApiRouteMetadata;
}

function oneApiLookupConfig(config: unknown): { baseUrl: string; apiKey: string } | undefined {
  const root = record(config);
  const models = record(root?.models);
  const providers = record(models?.providers);
  const oneapi = record(providers?.oneapi);
  const baseUrl = nonEmpty(oneapi?.baseUrl);
  const apiKey = nonEmpty(oneapi?.apiKey);
  if (!baseUrl || !apiKey) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" || !parsed.hostname || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return undefined;
    }
    return { baseUrl: parsed.origin, apiKey };
  } catch {
    return undefined;
  }
}

export async function lookupOneApiRoutingEvent(
  config: unknown,
  requestId: string | undefined,
): Promise<OneApiRouteMetadata | undefined> {
  const safeRequestId = safeIdentifier(requestId);
  const lookup = oneApiLookupConfig(config);
  if (!safeRequestId || !lookup) {
    return undefined;
  }
  const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(lookup.baseUrl);
  if (!policy) {
    return undefined;
  }
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url: `${lookup.baseUrl}/admin/routing-events/${encodeURIComponent(safeRequestId)}`,
      init: {
        headers: { Authorization: `Bearer ${lookup.apiKey}` },
      },
      auditContext: "orchestrator-route-oneapi-lookup",
      policy,
      timeoutMs: ROUTING_LOOKUP_TIMEOUT_MS,
    });
    const { response } = guarded;
    if (!response.ok) {
      return undefined;
    }
    const body = await response.text();
    if (body.length > 128 * 1024) {
      return undefined;
    }
    try {
      return parseOneApiRoutingEvent(JSON.parse(body));
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await guarded?.release().catch(() => undefined);
  }
}

export function buildOrchestratorRouteRecord(params: {
  started: StartedCall;
  ended: PluginHookModelCallEndedEvent;
}): OrchestratorRouteRecord {
  const { started, ended } = params;
  const oneapi = parseOneApiRouteMetadata(ended.providerResponseHeaders);
  return {
    role: started.role,
    sequence: started.sequence,
    runId: ended.runId,
    callId: ended.callId,
    ...(ended.sessionKey ? { sessionKey: ended.sessionKey } : {}),
    ...(ended.sessionId ? { sessionId: ended.sessionId } : {}),
    provider: ended.provider,
    selectedCandidate: `${ended.provider}/${ended.model}`,
    ...(ended.requestedModel ? { requestedModel: ended.requestedModel } : {}),
    ...(ended.fallbackActive !== undefined ? { openclawFallbackUsed: ended.fallbackActive } : {}),
    ...(ended.fallbackReason ? { openclawFallbackReason: ended.fallbackReason } : {}),
    oneapi: {
      ...oneapi,
      ...(oneapi.resolvedModel === undefined && ended.responseModel
        ? { resolvedModel: ended.responseModel }
        : {}),
    },
    ...(ended.responseModel ? { responseModel: ended.responseModel } : {}),
    outcome: ended.outcome,
    ...(ended.responseStatus !== undefined ? { responseStatus: ended.responseStatus } : {}),
    durationMs: ended.durationMs,
  };
}

export class OrchestratorRouteStore {
  private readonly started = new Map<string, StartedCall>();
  private readonly latestBySession = new Map<string, OrchestratorRouteRecord>();
  private readonly latestByRun = new Map<string, OrchestratorRouteRecord[]>();
  private readonly runSequences = new Map<string, number>();

  start(event: PluginHookModelCallStartedEvent): StartedCall {
    const sequence = (this.runSequences.get(event.runId) ?? 0) + 1;
    this.runSequences.set(event.runId, sequence);
    const started: StartedCall = {
      sequence,
      role: sequence === 1 ? "orchestrator" : "orchestrator_continuation",
      event,
    };
    this.started.set(event.callId, started);
    this.trimStarted();
    return started;
  }

  end(event: PluginHookModelCallEndedEvent): OrchestratorRouteRecord | undefined {
    const started = this.started.get(event.callId);
    if (!started) {
      return undefined;
    }
    this.started.delete(event.callId);
    const record = buildOrchestratorRouteRecord({ started, ended: event });
    const sessionKey = record.sessionKey ?? `run:${record.runId}`;
    this.latestBySession.set(sessionKey, record);
    const runRecords = this.latestByRun.get(record.runId) ?? [];
    runRecords.push(record);
    this.latestByRun.set(record.runId, runRecords.slice(-16));
    return record;
  }

  enrich(
    runId: string,
    callId: string,
    metadata: OneApiRouteMetadata,
  ): OrchestratorRouteRecord | undefined {
    const sessionRecord = [...this.latestBySession.values()].find(
      (record) => record.runId === runId && record.callId === callId,
    );
    const runRecords = this.latestByRun.get(runId);
    const runRecord = runRecords?.find((record) => record.callId === callId);
    const current = sessionRecord ?? runRecord;
    if (!current) {
      return undefined;
    }
    const updated = { ...current, oneapi: mergeOneApiRouteMetadata(current.oneapi, metadata) };
    const sessionKey = updated.sessionKey ?? `run:${updated.runId}`;
    this.latestBySession.set(sessionKey, updated);
    if (runRecords) {
      this.latestByRun.set(
        runId,
        runRecords.map((record) => (record.callId === callId ? updated : record)),
      );
    }
    return updated;
  }

  latest(sessionKey?: string): OrchestratorRouteRecord | undefined {
    if (sessionKey) {
      return this.latestBySession.get(sessionKey);
    }
    return [...this.latestBySession.values()].at(-1);
  }

  trace(runId: string): readonly OrchestratorRouteRecord[] {
    return this.latestByRun.get(runId) ?? [];
  }

  private trimStarted(): void {
    while (this.started.size > MAX_TRACKED_CALLS) {
      const first = this.started.keys().next().value;
      if (!first) {
        return;
      }
      this.started.delete(first);
    }
  }
}

export function formatRouteStatus(params: {
  config: unknown;
  agentId?: string;
  session?: { model?: string; modelProvider?: string };
  sessionKey?: string;
  latest?: OrchestratorRouteRecord;
}): string {
  const config = params.config as {
    agents?: {
      defaults?: { model?: unknown };
      list?: Array<{ id?: string; model?: unknown }>;
      entries?: Record<string, { model?: unknown }>;
    };
  };
  const modelValue = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      return value.trim() || undefined;
    }
    if (value && typeof value === "object" && "primary" in value) {
      const primary = (value as { primary?: unknown }).primary;
      return typeof primary === "string" && primary.trim() ? primary.trim() : undefined;
    }
    return undefined;
  };
  const global = modelValue(config.agents?.defaults?.model);
  const agent = params.agentId
    ? modelValue(
        config.agents?.list?.find((entry) => entry.id === params.agentId)?.model ??
          config.agents?.entries?.[params.agentId]?.model,
      )
    : undefined;
  const sessionOverride = params.session?.model
    ? `${params.session.modelProvider ? `${params.session.modelProvider}/` : ""}${params.session.model}`
    : undefined;
  const latest = params.latest;
  const lines = [
    "Orchestrator route visibility",
    `configured global intent: ${global ?? "unknown"}`,
    `agent primary (${params.agentId ?? "unknown"}): ${agent ?? "inherits global"}`,
    `session: ${params.sessionKey ?? "unknown"}`,
    `session override: ${sessionOverride ?? "none"}`,
    `effective candidate (last observed): ${latest?.selectedCandidate ?? "unknown"}`,
  ];
  if (!latest) {
    lines.push("last route: none observed");
    return lines.join("\n");
  }
  lines.push(
    `last route role/sequence: ${latest.role}/${latest.sequence}`,
    `last outcome: ${latest.outcome}`,
    `last OneAPI request ID: ${latest.oneapi.requestId ?? "unavailable"}`,
    `last OneAPI correlation ID: ${latest.oneapi.correlationId ?? "unavailable"}`,
    `last OneAPI requested alias: ${latest.oneapi.requestedModel ?? "unavailable"}`,
    `last OneAPI resolved model: ${latest.oneapi.resolvedModel ?? "unavailable"}`,
    `last OneAPI provider family: ${latest.oneapi.providerFamily ?? "unavailable"}`,
    `OpenClaw consumer fallback: ${latest.openclawFallbackUsed === undefined ? "unknown" : latest.openclawFallbackUsed}`,
    `OneAPI internal fallback: ${latest.oneapi.fallbackUsed === undefined ? "unknown" : latest.oneapi.fallbackUsed}`,
    `OneAPI runtime build: ${latest.oneapi.runtimeBuildId ?? "unavailable"}`,
  );
  return lines.join("\n");
}
