# Connect GBrain to OpenClaw

> This page is the MCP-registration reference card. For the full brain install
> — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the README covers the
> bootstrap and connect paths.

Two supported shapes, both stdio.

## Option 1: ClawHub bundle plugin

GBrain ships [`openclaw.plugin.json`](../../openclaw.plugin.json) at the repo
root. Installing the bundle plugin registers the MCP server for you — the
manifest carries an `mcpServers.gbrain` entry that runs the bundled
`.agents/gbrain-launcher serve` (the same launcher the Codex and Claude Code
plugins use; it resolves your installed `gbrain` via `GBRAIN_BIN`, then
`~/.bun/bin/gbrain`, then `PATH`, so it works under launchd's bare PATH and
never needs a build step) plus the bundled skills — and declares the
`gbrain-context-engine` context engine. To route OpenClaw's context-engine slot
through gbrain, two steps, in this order:

1. Install and enable the plugin by its own id, `gbrain-context-engine`
   (the `id` in `openclaw.plugin.json`).
2. Set the slot to the engine id the plugin registers:

   ```
   plugins.slots.contextEngine = gbrain-context-engine
   ```

The current host requires the canonical plugin ID in the slot. The installed
plugin ID is unchanged and `gbrain-context` remains a registry alias for older
integrations, but it is not a slot alias on current hosts: migrate an old
`plugins.slots.contextEngine = gbrain-context` setting to
`gbrain-context-engine`. Setting the slot alone does not install/enable the
plugin. For a legacy host that cannot provide a per-session workspace, set
`plugins.entries.gbrain-context-engine.config.workspaceDir` to an absolute
workspace path; on multi-agent hosts prefer the host-supplied workspace. An
unbound or ambiguous workspace warns and reads no source rather than selecting
an arbitrary agent's memory.

The factory also accepts zero arguments from current hosts. Its `assemble`
keeps the current prompt separate from fenced stored transcript history; an
identical trailing legacy user message is already the current turn. The
admitted-turn acknowledgement is stateless and writes nothing. Reflex-only
pointer synthesis leaves returned messages unchanged; the turn acknowledgement
does not automatically capture conversation content (compaction has its own
explicit checkpoint path). Loading the plugin alone is not evidence of model
recall: verify saved-page retrieval after a restarted turn and source isolation
with the intended host. The loopback native test uses a deterministic provider,
so it does not certify paid-model recall or provenance.

## Option 2: `openclaw mcp add`

OpenClaw keeps MCP servers under `mcp.servers` in `~/.openclaw/openclaw.json`
(`openclaw config schema` shows the key path). Register gbrain with the CLI:

```bash
openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve --arg --surface --arg starter --arg --advertise --arg verbs --env GBRAIN_HOME=$HOME
```

Use an absolute `--command` path: the launchd-started gateway's `PATH` does
not include `~/.bun/bin`, so a bare `gbrain` fails to spawn. `--env` is
optional: a PGLite brain needs no `DATABASE_URL`
(`--env DATABASE_URL=postgresql://...` for Postgres), and `GBRAIN_HOME` only
matters when the brain home isn't `~/.gbrain`. `--surface starter --advertise verbs`
lists the seven-verb memory protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md))
plus `request_tools`, which reaches every other tool; drop the
`--advertise verbs` values to list the starter set (`full` for the whole catalog) (check
`openclaw mcp add --help` for your version's `--arg` spelling).

Leave `GBRAIN_SOURCE` unset in the MCP env unless you deliberately want
single-source retrieval: a pin scopes every tool (search, `get_brain_identity`
counts, …) to that one source, and nothing warns on reads.

## One bot for several people, in DMs

**Say to your agent:** *"Set up my OpenClaw bot so each DM reads only what that
person may read"* (the agent follows this section), then *"Show what the brain
lets alice-example's DMs read"* (it runs
`gbrain access check --token openclaw-dm-bot --as alice-example` on the brain host).

A bot that answers several people, each in a DM, can give each DM that person's
view of the brain, within the bot's own source grant (`visibility: private`
pages stay hidden unless the token also has `--private-pages granted-sources`
or the host turns on `GBRAIN_REMOTE_PRIVATE_PAGES` or
`search.remote_private_pages`): a [shared agent](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape)
names the audience in the `X-Gbrain-On-Behalf-Of` header, and on OpenClaw a
small plugin sets that header from the DM's sender through OpenClaw's
[requester-scoped MCP connection resolver](https://docs.openclaw.ai/plugins/sdk-overview/infrastructure#requester-scoped-mcp-connections).
OpenClaw supplies the sender id, not the model, and the header travels on the
transport (an audience in tool arguments refuses `on_behalf_of_in_arguments`).

**DMs only.** The resolver is told who sent the turn (`requesterSenderId`, with
`messageChannel` and `agentAccountId`), not whether the turn came from a DM or a
group, nor who else is in the group. Sent on a group turn, the sender's member
would show the whole group what that one person may read. Use this only on a
gateway where no conversation has more than one person:
[`groupPolicy: "disabled"`](https://docs.openclaw.ai/channels/groups#group-policy)
on each channel, and `dm.groupEnabled` off on Discord and Slack. A group
audience needs membership that the resolver does not receive (#8534).

The header keeps the brain's answers apart; the gateway must keep the rest
apart too ([OpenClaw's trust model](https://docs.openclaw.ai/gateway/security/trust-model)
treats one gateway as one trust boundary, so people who must not trust each
other need separate gateways):

- [`session.dmScope: "per-channel-peer"`](https://docs.openclaw.ai/concepts/session#dm-isolation)
  (`per-account-channel-peer` with several accounts on one channel). The default
  puts every DM in one session, so one person's brain results would sit in the
  next person's context.
- `tools.sessions.visibility: "self"`, so session tools cannot read another
  person's DM transcript.
- No shell or file tools on the gateway host for this agent (sandbox it or deny
  them): commands there inherit the gateway's environment, which holds the bot's
  token, and a local `gbrain` CLI or brain database URL reads every page.
- Leave the `gbrain-context-engine` slot unset for this bot: it reads through
  the host's own brain connection, not through this token.

On the brain host, run `gbrain serve --http`
([legacy bearer tokens](DEPLOY.md#remote-with-legacy-bearer-tokens-simplest)),
then make a read token for the bot and list whom it may act for: each person's
member id, plus `guest` for senders who have none. Never `*`.

```bash
gbrain auth create openclaw-dm-bot --scopes read     # prints the token once
gbrain auth rescope --token openclaw-dm-bot --sources <source-id> --may-act-for alice-example,bob-example,guest
gbrain access check --token openclaw-dm-bot --as alice-example
```

Put the token in the gateway's environment as `GBRAIN_DM_BOT_TOKEN`, never in
`openclaw.json`. On the OpenClaw host, declare the server by URL alone (this
replaces Option 2's stdio entry; an `mcp.servers` entry also takes the place of
the bundle plugin's server of the same name):

```bash
openclaw mcp set gbrain '{"url":"https://brain.example.com/mcp","transport":"streamable-http"}'
```

Then write the plugin, a directory `gbrain-dm-audience` with three files.
`package.json`:

```json
{ "name": "gbrain-dm-audience", "version": "1.0.0", "private": true, "type": "module", "openclaw": { "extensions": ["./index.js"] } }
```

`openclaw.plugin.json`:

```json
{
  "id": "gbrain-dm-audience",
  "name": "GBrain DM audience",
  "description": "Sends each DM sender's gbrain member as X-Gbrain-On-Behalf-Of",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "url": { "type": "string" },
      "members": { "type": "object", "additionalProperties": { "type": "string" } }
    }
  }
}
```

`index.js`:

```js
export default {
  id: 'gbrain-dm-audience',
  name: 'GBrain DM audience',
  description: "Sends each DM sender's gbrain member as X-Gbrain-On-Behalf-Of",
  register(api) {
    const { url, members = {} } = api.pluginConfig ?? {};
    api.registerMcpServerConnectionResolver({
      serverName: 'gbrain',
      resolve(ctx) {
        const token = process.env.GBRAIN_DM_BOT_TOKEN;
        if (!url || !token) return null; // no gbrain server for this run
        const key = `${ctx.messageChannel ?? ''}:${ctx.requesterSenderId}`;
        const audience = Object.hasOwn(members, key) ? members[key] : 'guest';
        return { url, headers: { Authorization: `Bearer ${token}`, 'X-Gbrain-On-Behalf-Of': audience } };
      },
    });
  },
};
```

Install it, map each sender (`<messageChannel>:<requesterSenderId>`, as
OpenClaw passes them; only ids the channel authenticates, such as numeric user
ids, never display names or nicks) to a member, and restart the gateway:

```bash
openclaw plugins install --link ./gbrain-dm-audience --force --accept-capabilities
openclaw plugins enable gbrain-dm-audience
openclaw config set plugins.entries.gbrain-dm-audience.config '{"url":"https://brain.example.com/mcp","members":{"telegram:<sender id>":"alice-example"}}' --strict-json
```

Every connection carries a header: a sender with no entry reads as `guest`
(no restricted page, no private page). Without the header a call would
read as the token itself. To give unmapped senders no brain at all, return
`null` from `resolve` when `members` has no entry for the key. A mapped id
outside `--may-act-for` refuses `on_behalf_of_not_permitted`, and one listed
there that names no enabled member refuses `on_behalf_of_unknown_member`
([shared-agent refusals](../guides/write-refusals.md#shared-agent-refusals));
nothing is read either way. To stop the bot reading for someone, take them out
of `--may-act-for`: gbrain reads that list on every call, while OpenClaw keeps a
resolved connection for up to 5 minutes. Runs without a trusted sender (cron,
heartbeat, subagents) get no gbrain server from the resolver. Scheduled jobs
that use the wrapper below read as the brain owner, so never send their output
to someone's DM. To check from a DM, ask the bot to call `whoami`: its
`access.applied` names the audience the call read as.

## Brain-first instructions

Registering the server only makes the tools available. Agents seldom call a
brain nobody told them about, so finish either option with:

```bash
gbrain setup openclaw   # --dry-run previews; --workspace <dir> picks the agent
```

It writes one short marked block into the workspace `AGENTS.md` (from
`OPENCLAW_CONFIG_PATH` or `~/.openclaw/openclaw.json`: a sole agent's
workspace, else `agents.defaults.workspace`, else `~/.openclaw/workspace`; with
several agents, pass `--workspace`). Text outside the markers is never touched,
a re-run upgrades the block in place, `--no-instructions` opts out and is
remembered, and `--remove` takes it out. A thin-client install puts the same
block at the top of `GBRAIN-INSTRUCTIONS.md`.

A rule in `AGENTS.md` reaches the system prompt only, so setup also puts it next
to every user turn with a hook-only OpenClaw plugin, `gbrain-turn-rule`: its
`before_prompt_build` handler returns the rule as `prependContext`. The plugin is
self-contained (the rule text is in its code; it reads and calls nothing) and
lives in `<OpenClaw state dir>/gbrain/gbrain-turn-rule`. Setup installs it with
OpenClaw's own CLI:

```bash
openclaw plugins install --link <state dir>/gbrain/gbrain-turn-rule --force --accept-capabilities
openclaw plugins enable gbrain-turn-rule
openclaw config set plugins.entries.gbrain-turn-rule.hooks.allowConversationAccess true
```

OpenClaw requires `allowConversationAccess` before a non-bundled plugin's
`before_prompt_build` runs. With no `openclaw` on PATH, setup writes the plugin
and prints those commands to run on the OpenClaw host; restart a running gateway
afterwards. `--no-instructions` and `--remove` uninstall the plugin and delete
its directory. A re-run after an upgrade rewrites the plugin with the new text.

OpenClaw lists no gbrain tool after `openclaw mcp set`: the model reaches them
only through `tool_search`, whose results it frames as external data. With an
MCP connection the rule therefore names the tools (`recall`, `entity`, `search`,
`query`) and says to find them with `tool_search` and run them with `tool_call`.
With `openclaw` on PATH, setup runs
`openclaw plugins inspect gbrain-turn-rule --runtime --json` and exits non-zero
with `turn_hook_not_loaded` unless the plugin shows as loaded with
`before_prompt_build` ([repair](../guides/repair.md#turn-hook-not-loaded)).

## Scheduled jobs and workspace scripts

OpenClaw cron jobs, workspace scripts and hooks run with another `HOME` and
environment than the gateway's MCP server. Route every one of them through a
single wrapper that sets `GBRAIN_HOME`, loads the brain's env file and runs the
installed `gbrain` by absolute path; log its stderr and check its exit code
([the wrapper and its rules](../guides/cron-schedule.md#calling-gbrain-unattended)).
On a managed brain, scripts commit the files they write with
`gbrain git commit-push -- <paths>` (never plain `git commit`); a scheduled
`gbrain sources refresh <id>`
keeps it current
([scripts and the managed checkout](../guides/shared-checkout-git.md#scripts-and-the-managed-checkout)).

## Verify

`openclaw mcp list` should show `gbrain`. Then start an agent turn and ask it
to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

If the tools respond, the wiring works. `list_skills` shows everything the
brain can do (gated by `mcp.publish_skills` on the host).

## Remove

Delete `mcp.servers.gbrain` from `~/.openclaw/openclaw.json` (or run
`openclaw mcp remove gbrain` if your version has it), or uninstall the bundle
plugin.
