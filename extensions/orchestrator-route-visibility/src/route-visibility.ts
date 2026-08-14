import type {
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "openclaw/plugin-sdk/types";

const MAX_TRACKED_CALLS = 256;

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
  const fallbackUsed = booleanHeader(read("fallbackUsed"));
  const attempts = finiteInteger(read("attempts"));
  const latencyMs = finiteMilliseconds(read("latencyMs"));
  return {
    ...(read("schemaVersion") ? { schemaVersion: read("schemaVersion") } : {}),
    ...(read("requestId") ? { requestId: read("requestId") } : {}),
    ...(read("correlationId") ? { correlationId: read("correlationId") } : {}),
    ...(read("requestedModel") ? { requestedModel: read("requestedModel") } : {}),
    ...(read("resolvedModel") ? { resolvedModel: read("resolvedModel") } : {}),
    ...(read("providerFamily") ? { providerFamily: read("providerFamily") } : {}),
    ...(fallbackUsed !== undefined ? { fallbackUsed } : {}),
    ...(read("fallbackReason") ? { fallbackReason: read("fallbackReason") } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(read("runtimeBuildId") ? { runtimeBuildId: read("runtimeBuildId") } : {}),
    ...(read("outcome") ? { outcome: read("outcome") } : {}),
  };
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
    ? modelValue(config.agents?.list?.find((entry) => entry.id === params.agentId)?.model)
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
