# OneLibrary OpenClaw deployment contract

This directory is the versioned, non-secret deployment source for the
OneLibrary/OpenClaw contract. It is owned by the `s0pple/openclaw` runtime
fork because the fork is the writable source used to deploy the OpenClaw
runtime. OneAgent remains a secondary architecture/registry reference; it is
not the current deployment authority for the live `~/.openclaw` state.

The contract restores only portable behavior:

- the twelve read-only OneLibrary MCP tools, including `ask_book`;
- the deterministic Knowledge Guard plugin;
- the router instructions that keep book content on `ask_book` and keep
  terminal Knowledge statuses terminal.

It does not contain:

- Telegram or OneAPI credentials;
- session history, caches, SQLite state, or generated traces;
- provider configuration or routing policy;
- the OneLibrary MCP command, database path, or RAG path.

The existing OpenClaw configuration and plugin-path mechanisms are used. The
deployment command copies the portable plugin into the runtime's local plugin
directory, writes the router instructions, and applies a validated additive
config patch for the tool contract.

## Apply and validate

Run from the OpenClaw checkout after installing/updating OpenClaw:

```bash
node scripts/one-library-contract.mjs apply \
  --state-dir "$HOME/.openclaw" \
  --workspace "$HOME/.openclaw/workspace-router"

node scripts/one-library-contract.mjs validate \
  --state-dir "$HOME/.openclaw" \
  --workspace "$HOME/.openclaw/workspace-router"

openclaw config validate
```

The existing `mcp.servers.onelibrary` configuration and its external secret
references must already exist. This contract only updates the non-secret
tool-filter and router allowlist; it never creates or prints credentials.

Restart the gateway after applying the contract, then verify plugin loading and
run the Knowledge/progress smoke tests. Re-run the same apply command after a
package reinstall or update. It is deterministic and safe to repeat.

For an isolated clean-room root, pass explicit `--config`, `--plugin-dir`, and
`--workspace` paths. Do not copy the production `~/.openclaw` directory.

## Validation contract

The validator fails closed when:

- the OneLibrary tool filter is not exactly twelve tools;
- `ask_book` is absent;
- the router allowlist has an unexpected `onelibrary__*` tool;
- the deterministic-router plugin is not enabled and loadable;
- the mandatory router instruction markers are absent.

The validator does not inspect or reproduce OneAPI routing. OneAPI remains the
sole routing/fallback owner, and OneLibrary remains the Knowledge/evidence
owner.
