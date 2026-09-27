# GBrain for Grok Bot

Give Grok Bot durable, inspectable memory. The recommended shape runs the
brain on **your own computer**, publishes it over MCP with
`gbrain mcp expose --funnel`, grants the Bot a `memory-writer` client, and
installs the thin GBrain CLI inside the Bot; the Bot then saves the generated
memory instructions as a native skill. If you have no always-on machine,
install GBrain locally in `/workspace/gbrain` on the Bot computer instead.

**Say to your agent:** *"connect grok bot to my brain"* — *"use my brain over
mcp"*. On your computer, the `remote-mcp` skill publishes and grants; inside
the Bot, the paste-in prompt below installs the connection.

This guide covers the **Grok Bot personal agent**. The `grok` coding CLI has a
separate [Grok Build guide](../mcp/GROK.md). A Grok API key configures a model
provider; it does not install memory in Grok Bot.

## Choose your path

| Your situation | Use |
| --- | --- |
| You have (or can run) GBrain on your own computer — recommended | [Publish it over MCP](remote-mcp.md) with `gbrain mcp expose --funnel` (Funnel, because the Bot runs in the vendor's cloud, not on your tailnet), grant the Bot a client, then install the thin CLI inside the Bot ([hosted harness access](hosted-harness-access.md), adapter `grok-bot`). Memory lives where you can back it up and inspect it. |
| Already have a hosted GBrain elsewhere (cloud host, team brain) | Same client-side steps: [hosted harness access](hosted-harness-access.md), adapter `grok-bot`; choose the thin CLI for the complete remote command path |
| No always-on machine; want memory inside your Bot only | [Local setup](#alternative-install-gbrain-inside-the-bot) below; no model API key needed for the first fact/recall test |
| Want to keep the connection tailnet-only | Joining the Bot's runtime to your tailnet (userspace `tailscaled` with an ephemeral auth key) is possible in principle; it is advanced, not automated by gbrain, and unverified against a real Bot |
| Want a native Grok Bot MCP plugin | Native plugin authentication is unverified and release-gated; use the supported thin CLI path until an actual Bot pilot establishes the native connection |

## Recommended: your brain on your computer, reached over MCP

On the computer that holds the brain:

```bash
gbrain mcp expose --funnel                      # consent prompt, Tailscale install/login if needed, service, URL
gbrain mcp grant bot-example --harness grok-bot --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/bot-example.json
```

Move `/private/bot-example.json` to the Bot computer through a private file
channel (never paste it into the chat), then paste this into your Bot:

```text
Connect this Bot to my existing GBrain over MCP. Read:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/grok-bot.md
and its linked hosted-access guide.

The brain is published at https://your-machine.your-tailnet.ts.net/mcp and my
private credential file is at /private/bot-example.json on this computer.
Install GBrain under /workspace/gbrain on the Grok Bot cloud computer (reuse an
existing matching installation; do not replace existing state), then run
gbrain connect with --harness grok-bot, that credentials file, --install and
--root /workspace/gbrain. Use the generated absolute /workspace/gbrain/bin/gbrain
launcher for every memory command. Keep secrets out of chat and command output.

Run gbrain mcp verify and show me the server checks. Save the generated
GBRAIN-INSTRUCTIONS.md as a private native skill and enable it for this Bot;
keep your current identity and other instructions. Then remember a harmless
randomized test fact with provenance, recall it in a fresh conversation, and
tell me which native steps remain unverified.
```

The Bot's memory now lives on your machine: back it up, inspect it, and
revoke the Bot's client on the host whenever it should stop. `gbrain mcp
expose --status` on your computer re-checks the service and the public URL.

## Alternative: install GBrain inside the Bot

Use this when no computer of yours can stay online. Paste this into your Bot:

```text
Set up GBrain as my durable local memory. Read:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/grok-bot.md
and its linked in-agent setup guide.

Use /workspace/gbrain on the Grok Bot cloud computer. First inspect that path
and reuse an existing matching installation; do not replace existing state.
Run the shipped setup helper with --harness grok-bot. Use the generated absolute
/workspace/gbrain/bin/gbrain launcher for every memory command.

Start with keyless fact memory. Show me the search-mode matrix printed by init
and confirm my choice. Keep bulk capture and paid maintenance opt-in.
Save the generated memory instructions as a private native skill and enable it
for this Bot. Keep your current identity and other instructions.

Save a harmless randomized test fact with provenance, recall it through a
separate command, then help me test it in a fresh conversation. Show the actual
GBrain result and root used. Tell me which native setup steps remain unverified.
```

The exact shell commands, generated files, first test, repair, and recovery
procedure are in [Install GBrain inside a personal agent](in-agent-setup.md).
The rest of this guide's local-installation sections apply to this path.

## One shared brain for your Bots

Grok documents one account-wide cloud computer: files, browser sessions, and
command-line credentials are shared. It names `/workspace` for durable files
and treats manually installed packages as replaceable. Use one root and its
repair helper across Bots; separate Bot names or GBrain sources do not create
a privacy boundary on that computer.
[Grok Bot computer documentation](https://docs.x.ai/grok-bot/computer-and-apps)
(updated August 11, 2026; checked September 9, 2026).

Give each Bot the same absolute launcher. Keep memory calls finite and serialize
them when possible. If another Bot is using PGLite, retry after it finishes;
never remove the live database lock. Designate one Bot to own optional scheduled
maintenance so several Bots do not create duplicate routines.

## Attach the memory skill

Ask the Bot to save the memory instructions as a private skill —
`/workspace/gbrain/GBRAIN-INSTRUCTIONS.md` for a connection to your published
brain, `/workspace/gbrain/instructions/gbrain-skill.md` for a local
installation. Grok's
documented controls are **Settings → Plugins → Yours** to enable a private
skill for a Bot, and `/` in the composer to select it. Enable it for every Bot
that should use this installation. GBrain does not assume that Grok Bot reads
`AGENTS.md` automatically.
[Grok Bot skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
(updated August 11, 2026; checked September 9, 2026).

Test the skill explicitly first. Then start a new conversation and ask for the
randomized phrase without supplying it. Inspect the CLI call and returned
provenance. Also ask a second Bot to recall it after enabling the same skill.
This establishes use of the shared GBrain database rather than relying on an
answer the app may have retained elsewhere.

## Three useful things to try

- **A continuing project:** “Recall our project-example decisions, then help me
  choose the next step. Remember today's decision and its rationale.”
- **A preference across Bots:** “Remember that my meeting brief should start
  with the decision needed.” Ask a different enabled Bot to prepare the next
  brief and inspect its recall.
- **A connected-service workflow:** “Use your existing calendar and email
  plugins for tomorrow's meeting brief. Save only the commitments I explicitly
  ask you to keep, with links and dates.” Use Grok's normal plugin permissions;
  GBrain does not need those services' credentials to store the selected facts.

For corrections, recall the old fact, retire its ID, save the corrected fact
with provenance, and verify active recall. For deletion, use the returned fact
ID with `forget`; retained history and older backups need separate consideration.
See the [worked round trip](in-agent-setup.md#3-prove-the-first-memory-round-trip).

## Local installation maintenance and recovery

These steps apply when GBrain runs inside the Bot. For a hosted connection,
use `<ROOT>/GBRAIN-INSTRUCTIONS.md` and the
[hosted runtime repair procedure](hosted-harness-access.md#maintenance-removal-and-troubleshooting).

After a successful manual run, optionally ask one Bot to turn
`instructions/maintenance.md` into a native routine. Reuse the receipt's stable
routine identifier, select the schedule and time zone, and inspect its test run.
Grok documents native routines and their run history, but GBrain does not create
one automatically.
[Grok Bot routine controls](https://docs.x.ai/grok-bot/skills-routines-and-automations).

Use [full database backups](in-agent-setup.md#6-back-up-the-complete-local-database)
and an explicitly chosen protected off-VM copy. If packages disappear after a
computer update, run `bash /workspace/gbrain/bin/gbrain-setup`. If durable state
is lost, [restore into a new root](in-agent-setup.md#7-restore-into-a-new-root),
repair its launcher, verify memory, and reattach the skill and routine. Do not
reinitialize the old path to make an error disappear.

To stop, pause the native routine and disable the skill. Preserve the root and
backup until you deliberately choose to delete the data. For hosted access,
also revoke that Bot installation's grant on the host.

## Acceptance checklist and limits

The local installer and recovery path have hermetic repository tests. **An
actual Grok Bot account has not been used to verify this integration.** The
Tailscale publish path (`gbrain mcp expose`) has repository tests with a fake
Tailscale runner; a real tailnet, a real Funnel endpoint reached from a Bot,
and the Bot's native skill activation are separate observed steps. Before
calling your installation complete, check:

- For the published-brain path: `gbrain mcp expose --status` verifies on your
  computer and `gbrain mcp verify` passes its server checks from inside the Bot.
- The launcher writes, recalls, corrects, and forgets the randomized test fact.
- A fresh conversation invokes that same launcher through the native skill.
- Every intended Bot uses the same root; concurrent calls recover from a busy
  response without deleting locks.
- A full backup restores into a different root and returns the saved fact.
- If scheduling is enabled, the single native routine runs and reports a result.
- After a platform update, the root persists or the documented repair/recovery
  path succeeds; record the observed app version and date.

If a skill is absent from `/`, check its per-Bot enablement. If the command
disappears, follow the repair procedure for your local or hosted setup. If recall fails only in new conversations, inspect skill
selection and the absolute launcher path before changing the database. Hosted
network and OAuth failures belong to the
[hosted access troubleshooting flow](hosted-harness-access.md).

[Validation evidence and actual-harness acceptance](harness-validation.md).
