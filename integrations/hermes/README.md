# GBrain memory provider for Hermes

This standalone plugin connects Hermes' memory lifecycle to a shared GBrain
HTTP MCP server. Install the accompanying native `mcp_servers.gbrain` entry
for the server's full authorized operation catalog and shared skill resources.
The provider's seven `gbrain_*` tools stay fixed for each conversation.

The supported Hermes contract is pinned to
`NousResearch/hermes-agent@46d7718a52ff33accb15dc0501736fbdb6833cab`.
It implements the documented `agent.memory_provider.MemoryProvider` API;
no Hermes core files are modified. Hermes discovers this directory at
`$HERMES_HOME/plugins/gbrain/` and selects it through `memory.provider: gbrain`.
`plugins.enabled` is unnecessary; `plugins.disabled` must not contain `gbrain`.

```yaml
memory:
  provider: gbrain
  gbrain:
    url: https://brain.example/mcp
    entities: [people/alice-example, companies/acme-example]
    budget_tokens: 1200
    timeout_seconds: 3
    heartbeat_seconds: 300
    capture: false
mcp_servers:
  gbrain:
    url: https://brain.example/mcp
    headers:
      Authorization: "Bearer ${GBRAIN_MCP_TOKEN}"
    timeout: 15
    connect_timeout: 10
    tools:
      resources: true
      prompts: false
```

Store `GBRAIN_MCP_TOKEN` in the selected Hermes profile's `.env`, not in YAML.
For an existing installation use `hermes memory setup` to configure URL and
token. Start a new conversation after changing configuration. Local loopback
HTTP is supported; remote connections require HTTPS. Redirects are refused.
The GBrain server is the only database owner: this plugin opens no brain DB
and launches no embedded engine. A single-user local PGLite brain can stay in
classic/unmanaged persistence mode; Hermes provider/MCP use does not require a
canonical-root claim or managed-writer activation. For intentional managed
writers or shared-content publication, follow the host's reviewed
[claim-and-activate runbook](../../docs/architecture/topologies.md#claim-and-activate-runbook).
Recall works with a keyless keyword-only server and preserves its degradation
notices.

At the first turn and after compression or a session switch, `context_pack`
loads core memory and the configured standing entities. `recall` searches
relevant saved context before nontrivial turns. `delta` runs at the first wake
and after the configured interval when Hermes next calls prefetch; there is
no independent heartbeat timer. Returned memory stays in turn context, so
the system-prompt prefix and tool schemas do not change. Missing optional
boundary verbs produce a notice; unavailable or degraded retrieval never
silently claims a clean miss. The plugin does not implement durable
pre-compression checkpoints or advertise checkpoint API v2.

Active calls share the configured soft context budget (with a 64-token floor
per call). Pack/recall text may be trimmed with an explicit notice when their
combined rendering exceeds the character estimate. Delta text, complete
structured delivery metadata and provenance are preserved after delivery: the server may have advanced its
cursor, so trimming would lose changes. Delta's untruncated thread arm and
diagnostics may therefore exceed the soft token estimate; HTTP responses have
a separate 2 MiB hard safety limit.

`timeout_seconds` bounds each HTTP response and the entire prefetch operation,
including handshake, lock waiting and all active calls. Prefetch has an additional
7-second ceiling so it returns context and failure notices before pinned Hermes'
8-second external-provider deadline. Explicit tools and capture retain the
per-response bound; they do not inherit a concurrent turn's deadline.

Use a dedicated source-scoped token for a profile's actual access boundary.
Optional `memory.gbrain.source_id` narrows only operations whose advertised
schema supports the selector (`recall`, `remember`, `capture`, `get_page`).
Other provider operations refuse that selector rather than widening to the
connection's ambient scope. Sources organize memory; they do not isolate
agents sharing credentials. Token scopes and source grants remain enforced
by GBrain, including changes made after initial tool discovery.

Automatic capture is off by default. With `capture: true`, completed primary
human turns are sent as labeled transcript notes only if the server advertises
the boolean `capture.ambient` parameter; the plugin sends literal `ambient: true`
so the server checks its current authoritative ambient-writeback consent.
Older servers refuse automatic capture locally. Bot-authored turns, cron,
subagents and flush contexts are excluded. Only user/assistant turn strings
are sent; tool outputs and the full `messages` transcript are not transmitted.
No extraction model is invoked by this plugin. Pending/error receipts remain
visible and writes are not automatically retried. Capture request IDs are
deterministic for retries of the same session/turn. Ordinary human Hermes
turns carry no `turn_author`; explicitly supplied author metadata must have
`is_bot: false`.

Explicit `gbrain_remember` remains available with capture off, subject to the
server's write grant. It defaults to `visibility: private`; private facts cannot
be recalled through remote MCP. Choose `visibility: world` explicitly for facts
the user wants shared with connected agents. Saved world facts are readable by connected agents.
`gbrain_forget` withdraws a fact; original source text, history and backups may
remain. Full MCP operations use Hermes' names `mcp__gbrain__<operation>`.
Shared skills remain server-owned; use the native resource and skill tools.

## Tests

With the pinned Hermes checkout on `PYTHONPATH`, run:

```sh
PYTHONPATH=/path/to/hermes-agent python3 -m unittest discover -s test/hermes-python -v
```

The ordinary tests use the real Hermes ABC, profile home scope and secret scope,
replace only config persistence with an in-memory profile fixture, and exercise a
real isolated loopback JSON/SSE MCP server. They are provider contract tests, not
a complete Hermes CLI or fresh-conversation agent test.

The `Hermes provider` CI workflow checks out the exact Hermes SHA above, sets up
Bun 1.4.2, installs the repository's locked dependencies with
`bun install --frozen-lockfile --ignore-scripts`, and installs the minimal pinned
Python runtime dependencies needed by Hermes' native `MemoryManager` and MCP
stack. It runs `bun test test/hermes-managed-writer.test.ts` plus both
`test/hermes-python/validate_native.py` and
`test/hermes-python/native_manager_acceptance.py` on Python 3.12. The TypeScript
test proves one actual claimed/activated synthetic source through its resident
owner: Hermes transcript import creates managed files with raw metadata readback,
a stale multipart shrink submits coordinated `delete_page(expected_revision)`,
only committed receipts count, and reimport retains the deletion. Its recorded
result was 1 pass and 34 assertions; it does not establish every managed-writer
crash/restart/maintenance path. The Python validator checks native directory
discovery and real-loopback JSON/SSE provider contracts. The Python acceptance
invokes the actual GBrain CLI to install two temporary profiles, then calls the
pinned Hermes `MemoryManager` and provider/MCP APIs against the real isolated
loopback GBrain/PGLite fixture.

The native-manager acceptance has four tests: save/recall across manager
sessions, correction and withdrawal; MCP tool discovery plus a registry handler
and native `skill_view`; concurrent disjoint profile grants; and capture
consent off/on/withdrawal through a background worker plus warm-provider grant
revocation. It demonstrates native host API and named lifecycle behavior. It
does **not** run Hermes as a full agent, call a model, prove skill use by a
model, cover the complete MCP catalog, or establish Hermes catalog acceptance.
It also does not prove managed-writer lifecycle beyond the specific resident-owner
source test above, production Hermes store/WAL behavior, all persistence races,
Postgres lifecycle, or maintenance worker recovery. Optional Hermes plugins may
print missing `requests` warnings; those
are not acceptance assertions. The workflow path filters include the
integration, Python tests, real loopback helper, `src/**`, `package.json`,
`bun.lock`, and the workflow itself.

For a local run with the pinned checkout and the same locked GBrain dependencies:

```sh
python3.12 -m pip install 'ruamel.yaml==0.18.16' 'mcp==2.0.0' \
  'httpx2==2.7.0' 'starlette==0.31.1' 'python-dotenv==1.2.2'
HERMES_API_CHECKOUT=/path/to/pinned/hermes-agent \
  python3.12 test/hermes-python/validate_native.py
HERMES_API_CHECKOUT=/path/to/pinned/hermes-agent \
  python3.12 test/hermes-python/native_manager_acceptance.py
```

When a sandbox refuses loopback sockets, a separate parser/lifecycle check is:

```sh
PYTHONPATH=/path/to/hermes-agent python3 test/hermes-python/run_in_memory.py
```

That check replaces urllib's opener and does not prove native HTTP networking.
A `native_manager_acceptance.py` pass establishes the exact host APIs and
behaviors exercised above, not a live model-facing conversation. The
[parity checklist](../../docs/designs/HERMES_INTEGRATION.md) keeps the remaining
manual and catalog gates separate.

## Catalog submission

This directory is a standalone provider candidate, not an accepted Hermes catalog
entry. The tracked template is
[`docs/mcp/hermes-catalog.yaml.in`](../../docs/mcp/hermes-catalog.yaml.in); its
`<published-40-character-commit-sha>` is deliberately a placeholder and must not
be submitted. Do not replace it until the plugin is present in a published GBrain
commit and that exact commit SHA can be reviewed.

After publication, an owner or major contributor can submit a catalog entry to
Hermes using the full published commit SHA and `subdir: integrations/hermes`:

```yaml
name: gbrain
repo: https://github.com/garrytan/gbrain
sha: <published-40-character-commit-sha>
subdir: integrations/hermes
version: "1.0.0"
description: Shared memory over HTTP MCP; capture is opt-in and server-gated.
maintainer: garrytan
tier: community
category: memory
capabilities:
  provides_tools: []
  provides_hooks: []
  provides_middleware: []
  requires_env: [GBRAIN_MCP_TOKEN]
```

The catalog's general-registration tool/hook lists are empty because this
exclusive memory provider's tools and lifecycle are owned by MemoryManager,
not registered via `ctx.register_tool` or `ctx.register_hook`. Reviewers should
still inspect and disclose the seven provider tools, network traffic and opt-in
transcript capture. Run `hermes plugins validate --install-deps` against the
published directory. Then submit a separate Hermes catalog PR for human review.
Publication of the GBrain source, a valid local plugin, or a submitted PR does
not mean the catalog has accepted or listed it; only maintainer merge establishes
that distribution status. Future updates require a reviewed SHA-bump PR.

The catalog directory installs the memory provider. Use the canonical
`gbrain connect` flow as well to install the full native MCP connection and shared
skillpack; the provider alone does not establish skill distribution or prove
that a skill was activated in a fresh Hermes conversation.
