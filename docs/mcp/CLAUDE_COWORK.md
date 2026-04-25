# Connect GBrain to Claude Cowork

Three ways to get GBrain into Cowork sessions:

## Option 1: Remote (via self-hosted server + tunnel)

For Team/Enterprise plans, an org Owner adds the connector:

1. Go to **Organization Settings > Connectors**
2. Add a new connector with the MCP server URL:
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
3. Add Bearer token authentication in Advanced Settings
   (create one with `bun run src/commands/auth.ts create "cowork"`)
4. Save

Note: Cowork connects from Anthropic's cloud, not your device. Your server
must be publicly reachable (ngrok, Tailscale Funnel, or cloud-hosted).

## Option 2: Local Bridge (via Claude Desktop)

If you already have GBrain configured in Claude Desktop (via `gbrain serve`
stdio or a remote integration), Cowork gets access automatically. Claude
Desktop bridges local MCP servers into Cowork via its SDK layer.

This means: if `gbrain serve` is running and configured in Claude Desktop,
you don't need a separate server for Cowork.

## Option 3: Zo bash dispatch (via existing zo-computer MCP)

If you run gbrain on a [Zo Computer](https://zo.computer) workspace and
already use Cowork's existing `mcp__zo-computer__run_bash_command` tool,
gbrain CLI invocations work without configuring a separate MCP server. The
Cowork session reaches gbrain by shelling out to Zo:

```typescript
// From the Cowork session:
mcp__zo-computer__run_bash_command({
  cmd: 'cd /home/workspace/.vendor/garrytan-gbrain && PATH="/root/.bun/bin:$PATH" gbrain query "what do we know about Courtney?"'
})
```

This avoids running a separate MCP server, separate auth tokens, or a
custom HTTP wrapper. The trade-off is per-call quoting discipline — the
shell is the trust boundary, so payloads with special characters (quotes,
newlines, markdown fences, Unicode) need explicit quoting.

### When to use it

- You already have a Zo Computer workspace with gbrain installed.
- You don't want to run a separate MCP server (Option 1) or rely on Claude
  Desktop being open (Option 2).
- You're operating Cowork as an external session-scoped agent reaching a
  shared brain on Zo, rather than embedding gbrain in the local sandbox.

### Per-call quoting examples

```bash
# 1. Quoted strings — single-quote the gbrain payload, double-quote the cmd
cd /home/workspace/.vendor/garrytan-gbrain && gbrain query "Courtney McCoy"

# 2. Newlines / heredoc payloads
gbrain query "$(cat <<'PAYLOAD'
multi-line
question
PAYLOAD
)"

# 3. Markdown fences in payload — base64 encode to dodge shell parsing
echo 'YGBgcHl0aG9uCi4uLgo=' | base64 -d | gbrain ingest --kind=link --stdin

# 4. Slug arguments — backticks-in-prose stay safe with double-quoted cmd
gbrain get concepts/access-policy-cowork-zo

# 5. Multi-line chained pipeline — &&-chain or trailing backslash
cd /home/workspace/.vendor/garrytan-gbrain && \
  PATH="/root/.bun/bin:$PATH" gbrain sync --repo /home/workspace/brain --no-pull && \
  PATH="/root/.bun/bin:$PATH" gbrain embed --stale

# 6. Unicode — single-quote payloads with em-dashes / non-Latin scripts
gbrain query 'what does the policy say about “zero-human” constraints?'
```

### Future-state trigger

If `mcp__gbrain__*` tools ever appear directly in the Cowork connector
inventory, prefer Option 1 or Option 2 — direct MCP avoids the shell trust
boundary entirely. Until then, Zo bash dispatch is the fastest path from
zero to "Cowork can read my Zo gbrain."

## Which to use?

- **Remote server (Option 1):** works even when your laptop is closed,
  available to all org members. Best for teams.
- **Local Bridge (Option 2):** zero extra setup if Claude Desktop already
  has GBrain, but requires your machine to be running.
- **Zo bash dispatch (Option 3):** zero extra setup if you already use Zo
  Computer; per-call quoting is the only discipline to learn.
