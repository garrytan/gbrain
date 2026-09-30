# GBrain for Muse

Give Muse explicit, portable memory with provenance. The recommended shape
runs the brain on **your own computer**, publishes it over MCP with
`gbrain mcp expose --funnel`, grants Muse a `memory-writer` client, and
installs the thin GBrain CLI in Muse's durable user-files area as a client.
If no computer of yours can stay online, install a small local GBrain in that
durable area instead. Either way, establish the durable path first and start
keyless.

Durable preferences can be shared; local harness configuration cannot. Read
[memory boundaries](memory-boundaries.md) for provider text disclosure, remote
graph maintenance, and full-backup limits before enabling capabilities.

**Say to your agent:** *"connect muse to my brain"* — *"use my brain over
mcp"*. On your computer, the `remote-mcp` skill publishes and grants; inside
Muse, the paste-in prompt below installs the connection.

This guide covers **Meta's Muse personal agent**.

## Muse Code is a different product

Muse Code and third-party projects with similar names do not establish
capabilities for the personal agent. Use the `muse` adapter for this guide;
`muse-code` remains a separate identity in the harness registry.

## What the public design establishes

Meta describes a dedicated Linux VM, a Debian runtime cell, CLI-based tools,
custom skills, and custom connectors. Built-in connector credentials are kept
outside that cell; Sentinel controls connector actions and network egress.
These are a good basis for a small CLI integration, but the public document
does not specify a durable custom-tool directory, a native MCP registration
interface, or an installation API for GBrain skills.
[Meta's Muse technical design](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
(published September 8, 2026; checked September 9, 2026).

**Establish the persistent path in the actual Muse environment before installing.**
Do not copy Grok Bot's `/workspace` convention or place memory in an arbitrary
runtime home. A Linux shell existing today does not prove its files will survive
replacement of the runtime cell.

## Choose your path

| Your situation | Use |
| --- | --- |
| You have (or can run) GBrain on your own computer, and a confirmed durable user-files directory in Muse — recommended | [Publish it over MCP](remote-mcp.md) with `gbrain mcp expose --funnel` (Funnel, because Muse's runtime is in the vendor's cloud, not on your tailnet), grant Muse a client, then install the thin CLI at the durable root ([hosted harness access](hosted-harness-access.md), adapter `muse`) |
| Existing hosted brain elsewhere | Same client-side steps: [hosted harness access](hosted-harness-access.md), adapter `muse`, thin CLI |
| No always-on machine; new brain and a confirmed durable directory | [Local setup](#alternative-install-gbrain-inside-muse) below, adapter `muse` |
| No confirmed persistent custom-files location | Resolve that platform capability before installing either the thin CLI or durable local memory |
| Want to keep the connection tailnet-only | Joining Muse's runtime to your tailnet (userspace `tailscaled`, ephemeral auth key) is advanced, not automated by gbrain, and unverified; Sentinel's egress policy applies either way |
| A native MCP option appears in your account | Treat it as a new capability to verify; this guide does not claim Muse supports native MCP |

## Recommended: your brain on your computer, reached over MCP

On the computer that holds the brain:

```bash
gbrain mcp expose --funnel                      # consent prompt, Tailscale install/login if needed, service, URL
gbrain mcp grant muse-example --harness muse --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/muse-example.json
```

Deliver `/private/muse-example.json` into Muse's durable user-files area
through the product's supported secure file flow (never paste it into chat),
then paste this into Muse:

```text
Connect this agent to my existing GBrain over MCP. Read:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/muse.md
and its linked hosted-access guide.

First identify the documented or platform-confirmed durable user-files area
available to your runtime and choose an absolute gbrain root there; tell me the
persistence evidence, or report the blocker instead of using a temporary path.

The brain is published at https://your-machine.your-tailnet.ts.net/mcp and my
private credential file is at <durable-area>/private/muse-example.json.
Install GBrain at that root (reuse a matching installation; preserve existing
state), then run gbrain connect with --harness muse, that credentials file,
--install and the absolute --root. Use the generated absolute bin/gbrain
launcher for every memory command. Keep secrets out of chat and command output.
Use Muse's normal permission and secure credential flows for any blocked
download or egress; a denial is a reported boundary, not something to route
around.

Run gbrain mcp verify and show me the server checks. Attach the generated
GBRAIN-INSTRUCTIONS.md through the native custom-skill mechanism available in
this account and report its exact location or name; keep your current identity.
Then remember a harmless randomized test fact with provenance, recall it in a
fresh conversation, and report each unverified platform step separately.
```

Muse's memory now lives on your machine. `gbrain mcp expose --status` on your
computer re-checks the service and public URL; revoke Muse's client on the
host when it should stop.

## Alternative: install GBrain inside Muse

Use this when no computer of yours can stay online. Paste this into Muse:

```text
Set up GBrain as my durable memory. Read:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/muse.md
and its linked in-agent setup guide.

First identify the documented or platform-confirmed durable user-files area
available to your runtime. Inspect it and choose an absolute gbrain root there.
Tell me the persistence evidence. If you cannot establish persistence, report
that blocker instead of treating a temporary runtime directory as durable.

Use the shipped setup helper with --harness muse and that absolute --root.
Reuse a matching installation and preserve existing state. Use its generated
absolute bin/gbrain launcher for every memory command. Keep your current identity.

Start with keyless facts and recall. Show me init's search-mode matrix and
confirm my choice; keep paid maintenance and bulk capture opt-in. Attach the
generated memory instructions using the native custom-skill mechanism available
in this account, and report its exact location or name.

Save and recall a harmless randomized test fact, then help me verify a fresh
conversation actually invokes GBrain. Use Muse's normal permission and secure
credential flows for any blocked download or later hosted connection. Report
each unverified platform step separately from successful local CLI checks.
```

Once the durable root is established, follow the
[shared setup commands](in-agent-setup.md#2-run-the-shipped-setup-helper), replacing
the example root and selecting `--harness muse`. The helper works without root
and does not create a system service or agent identity. Initial fact storage and
recall do not require extracting credentials from a Muse connector. The rest
of this guide's local-installation sections apply to this path.

## Attach instructions and test a fresh conversation

Read the memory instructions — `<ROOT>/GBRAIN-INSTRUCTIONS.md` for a
connection to your published brain, `<ROOT>/instructions/gbrain-skill.md` for
a local installation — and save them through Muse's available
custom-skill or standing-instruction mechanism. Keep the exact absolute
`<ROOT>/bin/gbrain` path in that skill. Public documentation does not establish
an automatic `AGENTS.md` loader or hook API, so merely writing a repository file
is not evidence that Muse will use it.

Follow the [randomized round trip](in-agent-setup.md#3-prove-the-first-memory-round-trip).
In a fresh conversation, ask for the phrase without repeating it and inspect
the command result. Test a correction and deletion too. Record the actual
native skill location/name and the date of the test; the installer deliberately
leaves native integration marked unverified.

## Three useful things to try

- **A durable preference:** “Remember that I want a short recommendation followed
  by the evidence.” Ask a new conversation to recall that preference before
  preparing a recommendation.
- **A project handoff:** “Recall the current project-example decision and open
  questions. After we decide, remember the new decision with today's date.”
- **Existing connected services:** “Use your connected calendar and email to
  prepare this meeting. Save the selected commitments I ask you to retain,
  with source links.” Let Muse use its existing connectors and permissions;
  store the chosen facts in GBrain without duplicating service credentials.

Do not request raw connector tokens or change Sentinel policy to make GBrain
work. For a hosted brain, the allowed destination and secure credential delivery
are part of the [hosted setup](hosted-harness-access.md); finish them through the
actual product's supported flow. A denied request is a reported setup boundary,
not a reason to try another route around it.

## Local installation maintenance, backup, and recovery

These steps apply when GBrain runs inside Muse. A hosted connection instead
uses `<ROOT>/GBRAIN-INSTRUCTIONS.md` and the
[hosted runtime repair procedure](hosted-harness-access.md#maintenance-removal-and-troubleshooting).

After manual memory succeeds, use `<ROOT>/instructions/maintenance.md` as the
basis of an optional native schedule, if that feature is available in your
account. Maintain one routine for the installation and test it. Do not install
a speculative daemon or assume a shell cron is the product's native scheduler.

Create a [full private backup](in-agent-setup.md#6-back-up-the-complete-local-database)
and choose a protected off-VM copy explicitly. The raw database can contain
sensitive memories and authentication state. Its `0600` mode does not encrypt
it or protect against loss of the whole VM.

After a runtime replacement, use `bash <ROOT>/bin/gbrain-setup` to repair the
recorded package without resetting memory. If data is lost, restore into an
absent root, rerun the helper with `--harness muse`, reconnect excluded state,
and test before reattaching the native skill. The
[restore procedure](in-agent-setup.md#7-restore-into-a-new-root) preserves the
original brain and starts no automation.

To stop, pause the native routine and disable the skill. Keep the root and a
protected backup until you deliberately choose to delete the memory. Revoke
hosted grants separately if you connected to an existing brain.

## Acceptance checklist and limits

The local installer, CLI, and recovery path have hermetic repository tests.
**An actual Muse account has not been used to verify this integration.** The
Tailscale publish path (`gbrain mcp expose`) has repository tests with a fake
Tailscale runner; a real Funnel endpoint reached from Muse and Muse's native
skill activation are separate observed steps. The
remaining acceptance checks are concrete:

- Establish and record the durable root and its behavior across runtime replacement.
- For the published-brain path: `gbrain mcp expose --status` verifies on your
  computer and `gbrain mcp verify` passes its server checks from inside Muse.
- Complete allowed package downloads and run the generated launcher.
- Save, recall, correct, and forget the randomized fact through separate commands.
- Make a fresh conversation select the native skill and invoke that launcher.
- Restore a private backup into another root and verify the saved fact.
- If used, test the account's native schedule and its failure reporting.
- For a hosted brain, verify the real egress and secure credential flow; no
  native MCP or privileged credential-service integration is assumed.

If installation is blocked, preserve the exact platform denial. If memory works
only in the current conversation, inspect the native skill attachment. If the
runtime vanishes, run repair against the same durable root. If that root was not
preserved, restore a backup rather than initializing a replacement brain at the
old path. More errors and fixes are in the
[shared troubleshooting table](in-agent-setup.md#troubleshooting).

[Validation evidence and actual-harness acceptance](harness-validation.md).
