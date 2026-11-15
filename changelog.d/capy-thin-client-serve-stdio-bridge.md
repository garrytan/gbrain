**On a thin client, `gbrain serve` now connects a stdio-only agent harness to your remote brain instead of refusing.**

Install the gbrain CLI on the agent's machine, run `gbrain init --mcp-only` with an OAuth client from the brain host, and register `gbrain serve` as the harness's stdio MCP server, the same entry a local brain uses. Every call goes to the brain host with that client's grant and comes back unchanged, refusals included; the bridge opens no local database, stores no page text and adds no access. Reported and first proposed by @jel405 (#8543).

### Itemized changes

- Bare `gbrain serve` on a thin client is a stdio bridge. It accepts `--surface`, `--advertise` and `--source-guard` (the argv gbrain's plugins register); `request_tools {surface}` widens only the session and writes nothing on the host. `serve --http`, `--access` and the other host flags still refuse with `requires_local_engine`, with a fix that keeps the flags (`--access` points at registering a narrow read-only client instead).
- Bridge failures are v1 agent envelopes with a bounded recovery and a fix that never adds a scope. A write whose answer was lost keeps its `request_id` (`write_outcome_unknown`) so it can be checked or resent without writing twice. URLs in envelopes and stderr lose their userinfo, query and fragment.
- A call that names an audience (`_meta.on_behalf_of`) is relayed only to a host that enforces it (gbrain 0.60.543.0 or newer); otherwise the bridge answers `host_upgrade_required`.
- `gbrain doctor` on a read or read+write thin client reports the missing admin scope as expected instead of advising a re-register with admin.
- `gbrain agent register --harness openclaw` prints the lines to run on the OpenClaw machine: `gbrain init --mcp-only …` then `openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve …`.

<!-- behavior-change: thin_client_serve_stdio_bridge_8543 -->
