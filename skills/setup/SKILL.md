# Setup MBrain

Set up MBrain from scratch. Target: working brain in under 5 minutes.

## Install (if not already installed)

```bash
bun add -g github:meghendra6/mbrain
mbrain --version
```

If you are installing from a local source checkout, use the compiled binary path:

```bash
bun install
bun run build
mkdir -p "$HOME/.local/bin"
install -m 755 bin/mbrain "$HOME/.local/bin/mbrain"
command -v mbrain
mbrain --version
```

Do not rely on `bun link` unless the checkout has dependencies installed; it runs
the source `src/cli.ts` entrypoint directly. If `command -v mbrain` does not
resolve to `$HOME/.local/bin/mbrain`, add `$HOME/.local/bin` to the shell `PATH`
before continuing.

## Runtime profiles

MBrain has three setup profiles:

- **Local SQLite**: recommended default for one-person local/offline installs.
- **PGLite**: local Postgres-like compatibility profile.
- **Managed Postgres**: optional hosted/remote profile for pgvector scale,
  remote MCP, and cloud file/storage workflows.

Default to Local SQLite when the user wants "local Codex/Claude memory",
"offline", "no Supabase", or a personal brain on one machine. Use Managed
Postgres only when the user explicitly wants hosted scale, remote access, or
already has a Postgres connection string.

## Local/offline prerequisites

- Bun installed and on `PATH`
- A markdown knowledge base, Obsidian vault, or starter directory
- No required Supabase, OpenAI, Anthropic, or hosted database account
- Optional local embedding runtime such as Ollama for semantic backfill later

## Managed Postgres prerequisites

- A Postgres database with pgvector, such as Supabase, Neon, Railway, or
  self-hosted Postgres
- A `postgresql://` database connection string, not a Supabase project URL or
  anon key
- Optional OpenAI API key if using hosted embedding generation

## Available init options

- `mbrain init --local` -- recommended personal/offline SQLite path
- `mbrain init --pglite` -- local PGLite profile
- `mbrain init --supabase` -- interactive wizard (prompts for connection string)
- `mbrain init --url <connection_string>` -- direct, no prompts
- `mbrain init --non-interactive --url <connection_string>` -- for scripts/agents
- `mbrain doctor --json` -- health check after init

## Phase A: Local SQLite Setup (recommended default)

Use this path unless the user clearly asks for hosted Postgres:

```bash
mbrain init --local
mbrain doctor --json
mbrain setup-agent
```

If the user has both Codex and Claude Code, `mbrain setup-agent` detects both.
Claude Code MCP registration defaults to user scope. For a project-local Claude
registration, run:

```bash
mbrain setup-agent --claude --scope local
```

Manual MCP registration:

```bash
codex mcp add mbrain -- mbrain serve
claude mcp add -s user mbrain -- mbrain serve
```

Warnings about managed/Postgres-only capabilities are expected in local/offline
mode when the doctor output marks those surfaces as unsupported.

## Phase B: Managed Postgres / Supabase Setup (optional)

Use this path when the user explicitly wants hosted Postgres or remote/cloud
workflows.

For Supabase, guide the user through creating a project:

1. "Go to https://supabase.com and sign up or log in."
2. "Click 'New Project' in the top left."
   - Name: `mbrain`
   - Region: pick the one closest to you
   - Database password: generate a strong one and save it
3. "Wait about 2 minutes for the project to initialize."
4. "Find the connection string: go to your project, click **Get Connected** next
   to the project URL, then **Direct Connection String** > **Session Pooler**,
   and copy the **Shared Pooler** connection string (port 6543)."
5. Initialize mbrain:
   ```bash
   mbrain init --non-interactive --url "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
   ```
6. Verify: `mbrain doctor --json`

**OpenClaw/Hermes agent instructions:** Store the Supabase access token in your persistent
env as `SUPABASE_ACCESS_TOKEN`. mbrain doesn't store it, you need it for future
`mbrain doctor` runs. Generate at: https://supabase.com/dashboard/account/tokens

### BYO Postgres

If the user already has Postgres with pgvector:

1. Get the connection string from the user.
2. Run: `mbrain init --non-interactive --url "<connection_string>"`
3. Verify: `mbrain doctor --json`

If the connection fails with ECONNREFUSED and the URL contains `supabase.co`,
the user probably pasted the direct connection (IPv6 only). Guide them to the
Session pooler string instead (see Phase B step 4).

## Phase C: First Import

1. **Discover markdown repos.** Scan the environment for git repos with markdown content.

```bash
echo "=== MBrain Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* 2>/dev/null; do
  if [ -d "$dir/.git" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
echo "=== Discovery Complete ==="
```

2. **Import the best candidate.** For large imports (>1000 files), use nohup to
   survive session timeouts:
   ```bash
   nohup mbrain import <dir> --no-embed --workers 4 > /tmp/mbrain-import.log 2>&1 &
   ```
   Then check progress: `tail -1 /tmp/mbrain-import.log`

   For smaller imports, run directly:
   ```bash
   mbrain import <dir> --no-embed
   ```

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   mbrain search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep couldn't.

4. **Start embeddings.** Refresh stale embeddings (runs in background). Keyword
   search works NOW, semantic search improves as embeddings complete.

5. **Offer file migration.** If the repo has binary files (.raw/ directories with
   images, PDFs, audio):
   > "You have N binary files (X GB) in your brain repo. Want to move them to cloud
   > storage? Your git repo will drop from X GB to Y MB. All links keep working."

If no markdown repos are found, create a starter brain with a few template pages
(a person page, a company page, a concept page) from docs/MBRAIN_RECOMMENDED_SCHEMA.md.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or equivalent).
This replaces grep-based knowledge lookups with structured mbrain queries.

### BEFORE (grep) vs AFTER (mbrain)

| Task | Before (grep) | After (mbrain) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" brain/` | `mbrain search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/ \| head -5 && cat ...` | `mbrain query "what's the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `mbrain get people/pedro` |
| Find connections | `grep -rl "Brex" brain/ \| xargs grep "Pedro"` | `mbrain query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `mbrain search "name"` -- keyword match, fast, works without embeddings
2. `mbrain query "what do we know about name"` -- hybrid search, needs embeddings
3. `mbrain get <slug>` -- direct page read when you know the slug from steps 1-2
4. `grep` fallback -- only if mbrain returns zero results AND the file may exist outside the indexed brain

Stop at the first step that gives you what you need. Most lookups resolve at step 1.

### Sync-after-write rule

After creating or updating any brain page in the repo, sync immediately so the
index stays current:

```bash
mbrain sync --no-pull --no-embed
```

This indexes new/changed files without pulling from git or regenerating embeddings.
Embeddings can be refreshed later in batch (`mbrain embed --stale`).

### mbrain vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **mbrain** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. mbrain for facts about the world. memory_search for how
the agent should behave.

## Phase E: Load the Production Agent Guide

Read `docs/MBRAIN_SKILLPACK.md`. This is the reference architecture for how a
production agent uses mbrain: the brain-agent loop, entity detection, enrichment
pipeline, meeting ingestion, cron schedules, and the five operational disciplines.

Inject the key patterns into the agent's system context or AGENTS.md:

1. **Brain-agent loop** (Section 2): read before responding, write after learning
2. **Entity detection** (Section 3): spawn on every message, capture people/companies/ideas
3. **Source attribution** (Section 7): every fact needs `[Source: ...]`
4. **Iron law back-linking** (Section 15.4): every mention links back to the entity page

Tell the user: "The production agent guide is at docs/MBRAIN_SKILLPACK.md. It covers
the brain-agent loop, entity detection, enrichment, meeting ingestion, and cron
schedules. Read it when you're ready to go from 'search works' to 'the brain
maintains itself.'"

## Phase F: Health Check

Run `mbrain doctor --json` and report the execution envelope plus any failures or
warnings.

For Local SQLite, unsupported managed/Postgres-only surfaces can be reported as
unsupported capabilities without making the install unhealthy. The important
checks are:

- config exists and points at the expected local SQLite database
- schema is initialized
- local query/search works after import
- MCP registration points at `mbrain serve`

For Managed Postgres, also verify the database connection, schema, pgvector
extension, and any hosted embedding configuration the user chose.

## Error Recovery

**If any mbrain command fails, run `mbrain doctor --json` first.** Report the full
output. Interpret the output based on the active profile.

| What You See | Why | Fix |
|---|---|---|
| SQLite file missing | Local config points at a path that does not exist | Rerun `mbrain init --local` or set the intended `MBRAIN_DATABASE_PATH` |
| No pages found | Query before import | Import files into mbrain first |
| `mbrain serve` works in shell but not MCP client | Client has different PATH or config env | Use the default config path or register a wrapper script that exports env |
| Connection refused | Managed Postgres is paused, unreachable, or URL is wrong | Use a reachable connection string; for Supabase prefer Session pooler |
| Password authentication failed | Managed Postgres password is wrong | Reset or re-copy the database password |
| pgvector not available | Managed profile is missing vector extension | Enable pgvector in the database |

## Phase G: Auto-Update Check (if not already configured)

If the user's install did not include update checks, offer it:

> "Would you like daily MBrain update checks? I'll let you know when there's a
> new version worth upgrading to — including new skills and schema recommendations.
> You'll always be asked before anything is installed."

If they agree:
1. Test: `mbrain check-update --json`
2. Register daily cron (see MBRAIN_SKILLPACK.md Section 17)

If already configured or user declines, skip.

## Phase H: Sync Setup

The markdown brain repo is the source of truth. Choose the sync setup that fits
the active profile and user workflow:

- For a first local install, start with manual `mbrain sync --repo <path>` and
  verify that edited markdown appears in `mbrain search`.
- For daily local use, offer cron or watch mode if the user wants automatic
  refresh.
- For Managed Postgres, confirm the connection string supports the transaction
  behavior used by sync before recommending automation.

Verification is behavior-based:

- `mbrain stats` should show the expected page count.
- A test edit should appear in `mbrain search`.
- Optional embeddings can be backfilled later with `mbrain embed --stale`.

## Phase I: Verification

Run the smallest verification set that proves the selected profile works:

For Local SQLite:

```bash
mbrain init --local
mbrain import /path/to/brain
mbrain search "<phrase from imported notes>"
mbrain doctor --json
mbrain stats
```

For MCP install validation:

```bash
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

For Managed Postgres, read `docs/MBRAIN_VERIFY.md` and run the relevant managed
checks in addition to the local CLI/MCP checks.

## Schema State Tracking

After presenting the recommended directories (Phase C/E) and the user selects which
ones to create, write `~/.mbrain/update-state.json` recording:
- `schema_version_applied`: current mbrain version
- `skillpack_version_applied`: current mbrain version
- `schema_choices.adopted`: directories the user created
- `schema_choices.declined`: directories the user explicitly skipped
- `schema_choices.custom`: directories the user added that aren't in the recommended schema

This file enables future upgrades to suggest new schema additions without
re-suggesting things the user already declined.

## Tools Used

- `mbrain init --non-interactive --url ...` -- create brain
- `mbrain import <dir> --no-embed [--workers N]` -- import files
- `mbrain search <query>` -- search brain
- `mbrain doctor --json` -- health check
- `mbrain check-update --json` -- check for updates
- `mbrain embed refresh` -- generate embeddings
- `mbrain embed --stale` -- backfill missing embeddings
- `mbrain sync --repo <path>` -- one-shot sync from brain repo
- `mbrain sync --watch --repo <path>` -- continuous sync polling
- `mbrain config get sync.last_run` -- check last sync timestamp
- `mbrain stats` -- page count + embed coverage
