# Orchestrator Route Visibility

This bundled, read-only extension records safe model-call diagnostics for the
OpenClaw orchestrator. It keeps these values separate:

- OpenClaw's configured/requested candidate and consumer fallback.
- OneAPI's request ID, requested alias, resolved model, provider family,
  internal fallback, attempts, and runtime build identity.

The extension consumes only the public OneAPI response metadata exposed through
the generic `model_call_ended` hook and, when a streamed response exposes only
the request headers, the existing authenticated
`/admin/routing-events/:oneapi_request_id` diagnostic endpoint. It never reads
OneAPI logs or its database. Provider response headers are filtered by the
OpenClaw core to a non-secret allowlist before the plugin sees them.

The routing-event lookup is restricted to a configured loopback OneAPI endpoint,
uses the existing gateway credential without logging it, and only retains the
allowlisted requested/resolved/fallback/runtime fields. It does not select a
provider, retry a request, or provide a model fallback.

`/route-status` is an authenticated diagnostic command. Values labelled
“last” describe the most recent observed request and are not a promise about
the next route, especially when the configured intent is `auto-v0`.
