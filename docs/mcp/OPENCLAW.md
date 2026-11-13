# Connect GBrain to OpenClaw

> This page is the MCP-registration reference card. For the full brain install
> — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the README covers the
> bootstrap and connect paths.

Connect with [Option 2](#option-2-openclaw-mcp-add) (stdio) when the brain runs on
the gateway's machine, or with
[OpenClaw's own MCP client](#remote-brain-openclaws-mcp-client-over-https) when it
runs elsewhere. Option 1's ClawHub bundle is not available yet.
A bot that several people DM connects over HTTP as well: see
[One bot for several people, in DMs](#one-bot-for-several-people-in-dms).

## Option 1: ClawHub bundle plugin (not available yet)

This project publishes no ClawHub package yet. The package named `gbrain` on
ClawHub is an unofficial upload of an old 0.10.1 build whose manifest has no
`id`, so `openclaw plugins install clawhub:gbrain` stops with
`plugin manifest requires id`. Don't install it; use Option 2.

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

## Remote brain: OpenClaw's MCP client over HTTPS

When the brain runs on another machine, OpenClaw connects to its MCP endpoint
itself, over streamable HTTP with OAuth. That grant is scoped and revocable on
the brain host, while the stdio route above gives the gateway full local
database access.

```bash
openclaw gateway stop
openclaw mcp add gbrain --url https://<brain-host>/mcp --transport streamable-http --auth oauth
openclaw mcp login gbrain
openclaw mcp doctor gbrain --probe
openclaw gateway start
```

`mcp add`, `login` and `doctor --probe` refuse while the local gateway runs, so
stop it first and start it again after. `openclaw mcp login` runs the browser sign-in (on a headless host it prints a
`--code` command to finish with). OpenClaw registers its client through dynamic
client registration, so the brain owner turns that on and approves the consent
([native OAuth path](../guides/hosted-harness-access.md#native-oauth-path),
[self-service registration](ADMIN.md#self-service-dynamic-registration)). Until
the login succeeds, OpenClaw leaves the server out of agent turns. Publish the
endpoint with `gbrain mcp expose` ([remote MCP](../guides/remote-mcp.md)).

## One bot for several people, in DMs

When one OpenClaw bot answers several people, each in their own DM, each DM can
read only the pages that person may read. The bot speaks to the brain as a
[shared agent](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape):
every call carries an `X-Gbrain-On-Behalf-Of` header naming the person, and the
brain answers with that person's view, within the bot's own source grant. On
OpenClaw a small plugin sets the header from the DM's sender through the
[requester-scoped MCP connection resolver](https://docs.openclaw.ai/plugins/sdk-overview/infrastructure)
(`api.registerMcpServerConnectionResolver`). OpenClaw supplies the sender, not
the model, and the header rides on the transport; an audience put in tool
arguments is refused (`on_behalf_of_in_arguments`).

**Say to your agent:** *"Set up my OpenClaw bot so each DM reads only what that
person may read"*, then *"Show what alice-example's DMs can read"* (it runs
`gbrain access check --token openclaw-dm-bot --as alice-example` on the brain host).

**DMs only.** The resolver learns who sent the turn (`requesterSenderId`, with
`messageChannel` and `agentAccountId`), not whether the turn came from a group
or who else is in it. On a group turn the sender's view would be shown to the
whole group. Use this recipe only on a gateway where every conversation has one
person in it: set [`groupPolicy: "disabled"`](https://docs.openclaw.ai/channels/groups)
on each channel and turn `dm.groupEnabled` off on Discord and Slack. Group
audiences are tracked in #8534.

### Before you share a personal brain through the bot

Each DM reads as one member, so anything that relaxes privacy for a single
member relaxes it for every person the bot serves:

- **No private-pages grant on the bot.** Never give its token
  `--private-pages granted-sources`. With it, every mapped person reads every
  `visibility: private` page in the bot's sources, which on a personal brain are
  your own private pages.
- **Host hatches off.** `GBRAIN_REMOTE_PRIVATE_PAGES` and
  `search.remote_private_pages` apply to every remote caller on the host, this
  bot included. Leave both unset while the bot runs.
- **A dedicated token bound to no member.** Make a new token for the bot. Don't
  reuse your own agent's token or bind the bot's token to your member: your DMs
  through the bot then read like anyone else's, and your own agent keeps your
  full view.
- **Pages only you should read name you as their reader.** Today `access:
  private` and `visibility: private` hide a page from this bot. Clearing those
  labels, by hand or in bulk with `gbrain repair private-labels`, makes the
  pages readable in every DM and by `guest`. Before you clear them, give the
  pages you want to keep to yourself `readable_by: [<your member>]` or a folder
  rule (`gbrain access rule add --prefix <folder>/ --readers <your member>`).

`gbrain access check --token openclaw-dm-bot --as <member>` must show
`Private pages: none` for the bot.

### Keep the gateway's people apart too

The header separates the brain's answers. The rest of the gateway has to keep
people apart as well
([OpenClaw's trust model](https://docs.openclaw.ai/gateway/security/trust-model)
treats one gateway as one trust boundary, so people who must not trust each
other need separate gateways):

- [`session.dmScope: "per-channel-peer"`](https://docs.openclaw.ai/concepts/session)
  (`per-account-channel-peer` with several accounts on one channel). The default,
  `main`, puts every DM in one session, so one person's brain results land in
  the next person's context.
- `tools.sessions.visibility: "self"`, so session tools can't read another
  person's DM transcript.
- No shell or file tools for this agent on the gateway host: commands there
  inherit the gateway's environment, which holds the bot's token, and a local
  `gbrain` or database URL reads every page.
- Leave the `gbrain-context-engine` slot unset for this bot. It reads through
  the host's own brain connection, not the bot's token.

### On the brain host

Run `gbrain serve --http` ([deploy guide](DEPLOY.md)). Add each person as a
member, make a read-only token for the bot, and list whom it may act for: each
person's member id, plus `guest` for senders who have none. Never `*`.

```bash
gbrain access member add alice-example
gbrain access member add bob-example
gbrain auth create openclaw-dm-bot --scopes read     # prints the token once
gbrain auth rescope --token openclaw-dm-bot --sources <source-id> --may-act-for alice-example,bob-example,guest
gbrain access check --token openclaw-dm-bot --as alice-example
```

**Keep the token read-only.** An audience limits which existing pages a write
can reach, not where a new page lands. A write-capable token keeps its own
write grant whatever the header says, so a page made in one DM outside a ruled
folder (a new top-level page, a `capture` into `inbox/`) is read by everyone
the source admits, `guest` included, unless the write names `readable_by`,
which is the model's choice and not a fence. If the bot has to write for people
who must not affect each other's data, register one client per person with
`--bound-slug-prefixes <their folder>/`
([Model B](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape));
the resolver can return each sender's own credential.

### On the OpenClaw host

Put the token in the gateway's environment as `GBRAIN_DM_BOT_TOKEN`, never in
`openclaw.json`. Declare the server by URL alone. This replaces Option 2's stdio
entry, and an `mcp.servers` entry also takes the place of the bundle plugin's
server of the same name:

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
  "description": "Names each DM's sender to gbrain as X-Gbrain-On-Behalf-Of",
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
  description: "Names each DM's sender to gbrain as X-Gbrain-On-Behalf-Of",
  register(api) {
    const { url, members = {} } = api.pluginConfig ?? {};
    api.registerMcpServerConnectionResolver({
      serverName: 'gbrain',
      resolve(ctx) {
        const token = process.env.GBRAIN_DM_BOT_TOKEN;
        if (!url || !token || !ctx.requesterSenderId) return null;
        const sender = `${ctx.messageChannel ?? ''}:${ctx.requesterSenderId}`;
        const audience = Object.hasOwn(members, sender) ? members[sender] : 'guest';
        return { url, headers: { Authorization: `Bearer ${token}`, 'X-Gbrain-On-Behalf-Of': audience } };
      },
    });
  },
};
```

Install and enable it, map each sender to a member, and restart the gateway.
A sender key is `<messageChannel>:<requesterSenderId>` as OpenClaw passes them.
Map only ids the channel authenticates, such as numeric user ids, never display
names or nicknames.

```bash
openclaw plugins install --link ./gbrain-dm-audience --force --accept-capabilities
openclaw plugins enable gbrain-dm-audience
openclaw config set plugins.entries.gbrain-dm-audience.config '{"url":"https://brain.example.com/mcp","members":{"telegram:<sender id>":"alice-example"}}' --strict-json
```

### What each DM gets

- A mapped sender reads as their member: the pages every member may read, plus
  pages whose `readable_by` or folder rule lists them, within the bot's sources.
- An unmapped sender reads as `guest`: no restricted page and no private page.
  To give unmapped senders no brain at all, return `null` from `resolve` when
  `members` has no entry for the sender.
- A mapped member outside `--may-act-for` is refused
  (`on_behalf_of_not_permitted`), and one that names no enabled member is refused
  (`on_behalf_of_unknown_member`); nothing is read either way
  ([shared-agent refusals](../guides/write-refusals.md#shared-agent-refusals)).
- Runs without a trusted sender (cron, heartbeat, subagents) get no gbrain
  server from the resolver. Scheduled jobs that use the
  [wrapper below](#scheduled-jobs-and-workspace-scripts) read as the brain
  owner, so never send their output to someone's DM.

To stop the bot reading for someone, take them out of `--may-act-for`. gbrain
reads that list on every call; OpenClaw may keep a resolved connection for a
few minutes. To check from a DM, ask the bot to call `whoami`: its
`access.applied` names the audience the call read as, and `relaxation` must
read `none`.

## Brain-first instructions

Registering the server only makes the tools available. Agents seldom call a
brain nobody told them about, so finish either option with the primary route,
the per-turn rule:

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
`before_prompt_build` handler returns the rule as `prependContext` (without its
closing "answer" sentence on heartbeat, cron and exec-completion turns). The plugin is
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
Every agent on the gateway gets the plugin's rule, so a `--workspace` run leaves
it when it would name another server and `--no-instructions` there keeps it.

OpenClaw lists no gbrain tool after `openclaw mcp set`: the model reaches them
only through `tool_search`, whose results it frames as external data. With an
MCP connection the rule therefore names the tools (`recall`, `entity`, `search`,
`query`) and says to find them with `tool_search` and run them with `tool_call`.
With `openclaw` on PATH, setup runs
`openclaw plugins inspect gbrain-turn-rule --runtime --json` and exits non-zero
with `turn_hook_not_loaded` unless the plugin shows as loaded with
`before_prompt_build` ([repair](../guides/repair.md#turn-hook-not-loaded)).

## Skills (fallback)

`gbrain skillpack scaffold --harness openclaw` adds gbrain's skills to the
workspace. OpenClaw lists them in its prompt, but in harness-evals a listed
skill was followed on 1-3% of turns against 97-100% for the per-turn rule, so
install skills beside the rule, never instead of it. OpenClaw serves a skill
only whole: a SKILL.md larger than one read (64,000 characters on a model with
200k+ context, 32,000 at 100k-200k, 16,000 below, a 32,768-byte page when the
context window is unknown) gets "cannot be partially served" and nothing else.
Every SKILL.md gbrain installs for OpenClaw is at most 32,000 bytes
(`test/openclaw-route.test.ts`), so it loads on any model with 100k+ context
and when the window is unknown; on smaller models the 16,000-character cap
applies and the larger skills do not load.

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
