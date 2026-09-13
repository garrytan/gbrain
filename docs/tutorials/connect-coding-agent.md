# Add GBrain memory to Claude Code or Codex

Keep the coding agent and identity you already use. GBrain adds explicit memory
with provenance, corrections, and access from other harnesses. Start with a
local, keyless brain; connect a hosted brain if you already have one.

1. **Add memory here — recommended:** [local setup](#path-b-start-from-nothing-local-brain-local-agent).
2. **Connect memory hosted elsewhere:** [hosted setup](#path-a-connect-an-agent-to-a-brain-you-already-have).

Neither path requires a new personal-agent identity or a private repository.
For that separately requested workflow, see [personal-agent bootstrap](../guides/bootstrap.md).
For Grok Bot or Muse, use their [dedicated](../guides/grok-bot.md)
[guides](../guides/muse.md), which install an isolated absolute launcher.

## One setup prompt

Paste this into the coding agent you want to use:

```text
Add GBrain memory to this existing agent. Follow:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/tutorials/connect-coding-agent.md
Preserve my identity and unrelated configuration. Inspect any existing brain
before initializing. Start keyless, relay the required search-mode matrix, and
confirm my choice. Save only explicit requests to remember unless I opt into
automatic capture. Do not add paid enrichment, connectors, or schedules implicitly.
Verify a unique memory write/readback and report native activation and recall in
a new conversation separately. If my brain is hosted, provision there and install
the private handoff here using the actual harness adapter.
```

## Path B: start from nothing (local brain, local agent)

### B1. Install and inspect

Install Bun if needed, then the canonical GBrain distribution:

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain engine status --json
```

Follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) for prerequisites and
installation recovery. Inspect existing database/MCP configuration, brain
mounts, and source routing before initializing. A configured brain should be
reused or explicitly converted; do not replace it because a probe failed.

### B2. Initialize keyless memory

For the intended unconfigured local brain:

```bash
gbrain init --pglite --no-embedding
```

PGLite runs locally without a database server or Docker. **Relay the printed
search-mode cost matrix and confirm the user's choice before continuing**, as
required by [Step 3.5](../../INSTALL_FOR_AGENTS.md#step-35-confirm-search-mode-with-the-user-do-not-skip).
The matrix illustrates model API costs, not the price of a Codex or Claude
subscription. Choosing a mode does not enable paid APIs or automatic capture.

### B3. Save and read back one memory

Replace the suffix with a new random value and use the current date:

```bash
gbrain remember "Project-example's test phrase is amber-orbit-RANDOM-SUFFIX" \
  --entity projects/gbrain-setup --provenance "explicit setup test, YYYY-MM-DD" --json
gbrain recall projects/gbrain-setup --json
```

Keep the returned fact ID. The separate read must return the exact phrase with
its provenance. No bulk import is needed to make the first memory useful.

If you want to import an existing folder, select it explicitly and start with
`gbrain import /absolute/chosen/notes --no-embed`. Do not scan and import
unrelated files or start embedding work implicitly.

### B4. Connect your coding agent

Configure the agent you are using:

```bash
# Claude Code
claude mcp add gbrain -- gbrain serve --surface verbs

# Codex
codex mcp add gbrain -- gbrain serve --surface verbs
```

These launch a local stdio MCP process. Use the same intended brain and source
you inspected above; if an isolated installation already provided an absolute
launcher, use that command in place of the bare `gbrain`.

The verbs surface exposes exactly `recall`, `remember`, `entity`,
`synthesize`, `forget`, `context_pack`, and `delta`.
Start with keyless recall and remembering. Server-side synthesis and semantic
retrieval may require separately configured capabilities.

PGLite allows one process to own its database at a time. Do not launch two
independent stdio servers against the same local brain. Let the owner close
before another process opens it; do not remove a live lock. For concurrent
harnesses, use a [shared hosted brain](../guides/hosted-harness-access.md).

Follow the client guide's reload instructions:
[Claude Code](../mcp/CLAUDE_CODE.md) or [Codex](../mcp/CODEX.md).

### B5. Verify in the agent

Attach the instruction below to your existing `CLAUDE.md` or `AGENTS.md`,
preserving unrelated content. Ask the agent for the setup phrase, and observe
its actual `recall` call. Then start a new conversation and ask again without
repeating the phrase. An answer from the current conversation is not evidence
of persistent recall.

Ask for a correction and verify the stored replacement. Withdraw the test fact
with `forget`, then confirm it is absent from active recall. History, source
material, and backups may remain.

## Path A: connect an agent to a brain you already have

Use [hosted harness access](../guides/hosted-harness-access.md) for the full
procedure. There are two environments: the owner grants access on the brain
host, then you install the private handoff inside your coding agent's environment.

### A1. On the host, grant memory access

Start from the host's existing HTTPS MCP deployment. Preview or create a
separate `memory-writer` client for each intended agent:

```bash
gbrain mcp grant coding-example --harness codex --profile memory-writer \
  --source default --url https://brain.example.com/mcp \
  --credentials-out /absolute/private/coding-example.json --json
```

Use `--harness claude-code` for Claude Code. Add `--dry-run` to preview.
For a running PGLite host, supply the private `--admin-token-file` to use its
authenticated admin API and existing engine. An ordinary OAuth token or a URL
does not authorize provisioning.

Do not grant full access or administration solely to connect memory. Delegation
is a separate explicit capability with tool and path bindings.

### A2. Inside the coding agent, install the handoff

Transfer the credential file privately, then run:

```bash
gbrain connect https://brain.example.com/mcp --harness codex \
  --credentials-file /absolute/private/coding-example.json --install
```

Use the same harness identifier as the grant. The installer preserves unrelated
configuration and refuses ownership conflicts. Follow its reload instructions.
Keep the credential file out of chat and Git.

### A3. Verify the connection and the agent separately

```bash
gbrain mcp verify --client CLIENT_ID --harness codex \
  --url https://brain.example.com/mcp \
  --credentials-file /absolute/private/coding-example.json --json
```

The verifier checks actual server access, memory write/readback, and cleanup.
A `partial` result with exit code 2 means native-harness evidence remains
missing even when server checks passed. Repeat the new-conversation exercise
from B5 in the actual agent.

A profile grants authority; a surface selects visible tools. A full surface
cannot bypass operation or source grants. For repair, resume lost credential
delivery or update the existing grant as described in the hosted guide;
ordinary permission repair does not rotate secrets or duplicate clients.

## Now make it actually useful

### A compact standing instruction

Add this section to the agent's existing instructions:

```markdown
## GBrain memory

Recall relevant saved context before answering questions about preferences,
decisions, projects, or prior work. On the memory surface, use recall or entity;
only use paid synthesis when that capability has been configured and authorized.

Save explicit requests to remember with provenance and the intended brain/source.
Do not automatically capture conversations unless I opt in. A request to save one
fact does not enable ongoing capture. Chat-only instructions suppress persistence.

Before correcting a fact, read the stored record, retire its old ID, save the
replacement with provenance, and verify it. Forget means withdrawal from active
memory; history, source material, and backups may remain.

Use the installation's recorded absolute launcher when present. Verify mutations
with actual readback, cite retrieved records, and say when a tool or native
instruction is unavailable. Never claim cross-conversation recall from this chat
alone. Preserve my native memory, identity, and unrelated instructions.
```

### Three useful workflows

1. **Decisions:** “Remember that project-example chose option B for offline
   support, with today's design review as the source.” Later: “What did we
   choose and why?” Observe the saved record being retrieved.
2. **Preferences:** “Remember that I want review findings ordered by severity.”
   Start a new conversation and request a review; check that the agent recalled
   the preference.
3. **Corrections:** “Our deployment target changed from staging-a to staging-b.
   Correct the saved decision.” Read back the current record and its provenance,
   then use it in the next planning session.

Automatic capture is optional. If you want it, explicitly choose what the agent
may save and follow [ambient writeback](../guides/ambient-writeback.md).
Paid enrichment, background delegation, and account connectors remain separate.

## Maintenance, removal, and troubleshooting

Run diagnostics with the intended launcher. Keyless brains do not need an
embedding API key to remember and retrieve explicit facts. Add a schedule only
when requested, and verify that the actual scheduler loaded it.

For a local PGLite brain, use [complete private backup and restore](../guides/in-agent-setup.md#6-back-up-the-complete-local-database);
a Git clone omits database-only memory. Restore to a new root and explicitly
reattach schedules and external sources. Hosted backups belong on the host.

Remove a manually added local MCP entry using the client's documented controls,
and remove only the memory instruction section you added. For a managed hosted
connection, repeat `gbrain connect` with its handoff and `--remove`.
Revoke the client on the host when its authority should end. Removing a client
configuration does not delete memory or revoke credentials.

| Symptom | Next step |
| --- | --- |
| PGLite busy | Close the current owner before opening another process. Never delete a live lock. |
| Wrong or empty brain | Inspect root, engine, brain, and source routing; do not initialize over existing memory. |
| Only seven tools visible | Expected for the verbs surface; use `recall` and `remember` rather than classic tool names. |
| Hosted read works but write fails | Inspect issued/current scopes, operation grants, source access, and write fences. |
| Credential delivery interrupted | Resume delivery on the host with the existing client ID. |
| Server checks pass, new conversation fails | Reload the client, confirm native instruction activation, and observe the actual GBrain call. |
| Optional embeddings unavailable | Continue keyless or explicitly configure the capability; do not silently spend. |

As of **2026-09-10**, local CLI and HTTP tests establish the server behavior
described in [validation evidence](../guides/harness-validation.md).
They do not prove instruction activation or cross-conversation recall in your
specific coding-agent session. Record those checks separately.
