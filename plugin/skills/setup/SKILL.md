---
name: setup
description: Add keyless GBrain memory to an existing agent, or connect a hosted brain while preserving identity and configuration
triggers:
  - "set up gbrain"
  - "initialize brain"
  - "gbrain setup"
  - "install gbrain into this agent workspace"
  - "add gbrain to my agent"
tools:
  - get_stats
  - get_health
  - sync_brain
  - put_page
mutating: true
---

# Set up GBrain memory

Give the agent the user already has a reliable memory. Preserve its identity,
native memory, existing instructions, and unrelated configuration. Start with
keyless storage and keyword retrieval. A private repository, identity interview,
automatic capture, paid API key, or background service is not a prerequisite.

## Contract

- Select the intended brain and source before inspecting or changing installation state.
- Reuse a healthy installation; diagnose partial or conflicting state without reinitializing memory.
- Relay the mandatory search-mode matrix and obtain the operator's choice.
- Save explicit memories with provenance and verify a randomized write/readback.
- Report software installation, native instruction activation, and cross-conversation recall separately.
- Automatic capture, imports, connectors, schedules, and paid enrichment require explicit opt-in.

## Phase 1: Choose the path

Use the user's existing context; do not repeat choices they already made.

| Intent | Action |
| --- | --- |
| Add memory inside Grok Bot | Follow [Grok Bot](../../docs/guides/grok-bot.md) and the isolated [setup helper](../../docs/guides/in-agent-setup.md). Root: `/workspace/gbrain`, with data under `.gbrain`. |
| Add memory inside Muse | Follow [Muse](../../docs/guides/muse.md). Establish its durable user-files location first. Do not invent `MUSE.md`, a persistent path, or a native MCP mechanism. |
| Add memory to another existing agent | Follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the [coding-agent tutorial](../../docs/tutorials/connect-coding-agent.md) covers Claude Code and Codex. |
| Connect an existing hosted brain | Follow [hosted harness access](../../docs/guides/hosted-harness-access.md). Provision on the host and install the private handoff inside the intended harness. |
| Explicitly create a new personal agent with identity and a private repo | Follow [BOOTSTRAP_FOR_AGENTS.md](../../BOOTSTRAP_FOR_AGENTS.md). `gbrain bootstrap` is for this explicit request. |
| Explicitly configure per-worktree code engines with shared artifacts | Follow [topologies](../../docs/architecture/topologies.md). Brain and source routing must be set independently. |

If intent is unclear, default to memory for the existing agent. Ask only for
missing information needed to choose a safe target, such as which existing
brain to connect or which Muse directory is durable.

## Phase 2: Inspect, install, or repair

For an existing installation, use its recorded absolute launcher when present:

```bash
gbrain engine status --json
gbrain engine status --probe
```

These commands work while the database is down. Inspect the engine,
configuration provenance, root, and source. Ambient database/MCP settings or a
working-directory mount are not authorization to adopt that database.
`GBRAIN_HOME` alone does not isolate all routing.

For Grok Bot/Muse, let the setup helper inspect and isolate the chosen root.
Do not run another global init around it. Its receipt distinguishes absent,
partial, malformed, and conflicting state. Repair uses the retained
`<root>/bin/gbrain-setup`; adoption and upgrades require explicit options.
Never replace existing memory to recover from an initialization error.

For other local installations, resolve conflicting routing before following
the canonical distribution and keyless initialization:

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite --no-embedding
```

Install Bun first if missing, following
[INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md). Do not use the unrelated
npm package named `gbrain`, or `bun add` in the user's current project.
Local/thin-client conversion requires explicit intent and preservation of the
previous configuration.

**Required search-mode choice:** initialization may select a noninteractive
default and print a nine-cell cost matrix with `[AGENT]` markers. Relay that
matrix and confirm the operator's choice before continuing. Follow Step 3.5 of
[INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); use the printed matrix,
not remembered prices. Illustrative model API costs are separate from a
harness subscription. This choice does not enable paid APIs or capture.

If the user explicitly wants Postgres, follow [engines](../../docs/ENGINES.md)
or [postgres-adopt](../postgres-adopt/SKILL.md). `--prefer-postgres` is optional.
Supabase uses a database connection string, not an anon key. Keep credentials
private and do not copy ambient secrets into file configuration.

### Hosted alternative

Skip local database initialization, import, and maintenance installation.
The owner provisions a `memory-writer` grant on the brain host or through its
authenticated admin API using `gbrain mcp grant` and a private
`--credentials-out` file. Use the actual harness identifier. A running PGLite
server must use its existing engine; do not open the live database in a second
process. A URL or ordinary OAuth token is not administration authority.

Privately transfer the handoff to the intended harness, then install there:

```bash
gbrain connect https://brain.example.com/mcp --harness codex \
  --credentials-file /absolute/private/agent-example.json --install
```

Thin CLI adapters also need the verified persistent `--root`. Follow the
adapter's reload instructions and the complete [hosted guide](../../docs/guides/hosted-harness-access.md).
Do not grant `admin` merely to make a convenience health command pass.
Delegation requires an explicit choice, bound tools, an active source, and a
path policy. New delegation has unlimited spending and concurrency 1; explain
this before granting it.

## Phase 3: Attach the memory instruction

Preserve existing instruction files. Add one identified memory section through
the actual harness's supported mechanism. For Grok Bot/Muse, use the generated
`instructions/gbrain-skill.md`; generating a file does not prove activation.

The standing instruction must say:

1. Recall relevant saved context before answering personal or ongoing-work questions.
2. Save explicit requests to remember, with provenance and the intended brain/source.
3. Read the stored record before a correction; retire the old fact, save the correction, and verify it.
4. Use `forget` for withdrawal from active memory. History, source material, and backups may remain.
5. Automatic capture needs opt-in; paid enrichment and delegation need their own authority.
6. Use the recorded absolute launcher when present. Verify each claimed change with an actual call.

Sources organize memory; they do not isolate agents sharing local files or
credentials. Preserve the user's native memory and identity.

## Phase 4: Verify what actually works

Follow the selected guide's commands. Save a randomized harmless fact with
provenance, keep the returned ID, and read it back in a separate call. Correct
it, withdraw the test fact, and verify active recall omits it. Reconcile a lost
mutation response before retrying.

Run `gbrain doctor --json` for diagnostics. Missing optional embeddings are an
unconfigured capability, not permission to add paid keys. A health score or a
successful process exit alone does not prove the memory round trip.

For hosted clients, run `gbrain mcp verify` with the private credentials file.
Report transport, authentication, permissions, read/write, cleanup, and worker
checks separately. Overall `partial` (exit 2) means native evidence is missing.

Open a new conversation in the actual harness, ask for a second randomized
test fact without repeating it, and observe the recorded launcher or MCP call.
If the harness is unavailable, mark this check unverified. Clean up the
fixture and report any failed cleanup by ID.

## Optional capabilities and maintenance

Only proceed with capabilities the user requested:

| Capability | Next step |
| --- | --- |
| Import selected notes or chat exports | Confirm the selected source; follow [ingest](../ingest/SKILL.md) or [conversation archive](../conversation-archive/SKILL.md). Do not scan and import arbitrary directories. |
| Connect an account | Follow [chat connectors](../chat-connectors/SKILL.md) or [Google setup](../../docs/guides/google-connect.md), preserving their credential and consent boundaries. |
| Automatic conversation capture | Follow [signal detector](../signal-detector/SKILL.md) after opt-in. Recall and explicit remembering work without it. |
| Paid retrieval or enrichment | Configure the chosen capability and budget separately. Existing API keys do not imply permission to spend. |
| Scheduled maintenance | For in-agent installs, reuse the generated routine ID and absolute launcher; start with bounded `doctor --fast --json`. Observe native activation. Hosted clients use the host's existing schedule. |
| Sync a selected file source | Follow [live sync](../../docs/guides/live-sync.md). Keyless sync uses `--no-pull --no-embed`; do not implicitly add embedding or a worker. |
| Import more data later | Offer [cold start](../cold-start/SKILL.md) as an optional next step; do not launch it automatically. |
| Upgrade | Follow [gbrain-upgrade](../gbrain-upgrade/SKILL.md) and the installation's recorded repair/upgrade policy. |

Facts, corrections, jobs, and accounting can exist only in the database.
A Git clone is not a complete backup. For PGLite, use the
[private backup and restore procedure](../../docs/guides/in-agent-setup.md#6-back-up-the-complete-local-database).
Treat the whole archive as sensitive; off-VM copies require an explicit
destination. Restore into an absent new root, then reattach external roots,
connectors, and schedules explicitly.

## Error recovery

| Failure | Next action |
| --- | --- |
| Database unreachable | `gbrain engine status --probe`, then `gbrain db-repair`; apply safe fixes within authorized repair scope. |
| Partial in-agent setup | Run the receipt's exact recovery command; preserve completed stages and memory. |
| PGLite busy | Let the live owner finish, then retry. Never remove a live lock. |
| Malformed or conflicting config | Report the conflict and intended target; do not reinitialize or overwrite unrelated settings. |
| Lost hosted handoff | Resume delivery on the host; distinguish lost access-token delivery from lost client-secret delivery. |
| Native instructions or routine unavailable | Keep the content and report the remaining activation step. |
| Optional health check unavailable | Name the missing capability; do not silently expand grants, spend, or connector access. |

## Anti-Patterns

- Replacing an existing agent's identity or creating a private repository during ordinary memory setup.
- Treating ambient configuration, available API keys, or a successful probe as permission to adopt data or spend.
- Automatically enabling capture, importing unrelated files, or installing a worker to improve a health score.
- Reinitializing memory to repair a partial install, removing a live lock, or rotating credentials during ordinary grant repair.
- Declaring native activation or cross-conversation recall complete without observing it.

## Output Format

Report the actual root/database/source or hosted endpoint, installed version,
memory round trip, instruction activation, cross-conversation evidence, and
cleanup. Name pending steps and the exact repair action. Redact credentials.

Only declare observed stages complete. A CLI test, schedule file, fluent
answer, HTTP response, or job ID cannot certify the full native experience.
