# Connect and administer GBrain MCP

Choose the task first. Connecting a harness and administering the server use
different credentials.

| Task | Start here | Required access |
| --- | --- | --- |
| Run an HTTP MCP server | [Deployment](DEPLOY.md) | Access to the brain host and its service configuration |
| Open the admin panel or manage clients | [MCP administration](ADMIN.md) | The running server's separate owner bootstrap credential |
| Connect an existing agent | [Hosted harness setup](../guides/hosted-harness-access.md) | Native OAuth/PKCE, or a private machine-client handoff |
| Run a local MCP pipe | [Local stdio](DEPLOY.md#local-stdio-zero-setup) | A local GBrain installation; no HTTP admin panel is created |
| Diagnose a failed connection | [Recovery table](ADMIN.md#recover-a-failed-step) | Start with the failed stage and the authority you actually hold |
| A tool call returned an error | [A tool call returned an error](#a-tool-call-returned-an-error) | None: the error says who acts |

**For agents:** read [the MCP access skill](../../skills/mcp-access/SKILL.md).
If skill tools are unavailable, the instructions here and in
[ADMIN.md](ADMIN.md) work directly. A connected harness can also read
`gbrain://capabilities` for its effective permissions and administration guidance.

**Owner administration is separate from MCP `admin` scope.** An OAuth access
token, client secret, or ordinary MCP connection does not authorize dashboard
login, client creation, or client revocation. A public PKCE client has no client
secret. Ask the server-hosting harness or a separately authorized administrator
to perform owner actions.

Say to that administrator: “Open the admin panel for my running GBrain server.
Use its configured endpoint and protected owner credential. Give me a fresh
single-use login link without opening it yourself.”

Say to the connecting agent: “Connect this harness to my hosted GBrain. Use its
native OAuth flow if available; otherwise use a private machine handoff. Follow
the hosted setup guide and report configuration separately from an observed
connection in this harness.”

Client-specific details: [ChatGPT](CHATGPT.md), [Claude Code](CLAUDE_CODE.md),
[Claude Desktop](CLAUDE_DESKTOP.md), [Codex](CODEX.md),
[opencode](OPENCODE.md), [Perplexity](PERPLEXITY.md),
[OpenClaw](OPENCLAW.md), and the [adapter reference](../guides/harness-adapters.md).

## A tool call returned an error

Every gbrain tool error is one content block holding a JSON envelope. Read
`code` (an older server sends only `error`), then follow `fix.next`:

- `run`: call `fix.mcp` (or run `fix.argv` where you have a shell) exactly as given.
- `ask_user`: relay `user_message` and stop; act only after the user agrees.
- `tell_user_to_run`: the fix needs the user or the brain host's operator
  (for example a scope grant or a CLI-only repair); give them `fix.command`.
- `wait`: retry after the stated delay with the same request.
- `report`: tell the user what happened; the host operator runs `gbrain doctor --json`.

Then run `fix.verify`, which is always read-only. A mutating call with an
unknown outcome points at its write receipt (`get_write_request`), never at a
blind retry. Successful results can carry extra `[gbrain notice …]` text blocks
after `content[0]`; read them too (a `degraded` notice means an empty result is
not proof the user has no notes). Full contract, including the scope-failure
`error`/`code` pairs: [AGENT_OPERATOR_v1](../protocol/AGENT_OPERATOR_v1.md).
