# GBrain Installation Guide for AI Agents

Read this entire file, then follow the steps. Ask the user for API keys when needed.
Target: ~30 minutes to a fully working brain.

## Step 0: If you are not Claude Code

Read `AGENTS.md` at the repo root first. It's the non-Claude-agent operating
protocol (install, read order, trust boundary, common tasks). Claude Code reads
`CLAUDE.md` automatically and can skip ahead.

If you fetched this file by URL without cloning yet, the companion files live at:
- `https://raw.githubusercontent.com/garrytan/gbrain/master/AGENTS.md` — start here
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms.txt` — full doc map
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms-full.txt` — same map, inlined

## Step 1: Install GBrain

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Verify: `gbrain --version` should print a version number. If `gbrain` is not found,
restart the shell or add the PATH export to the shell profile.

> **Do NOT use `bun install -g github:garrytan/gbrain`.** Bun blocks the top-level
> postinstall hook on global installs, so schema migrations never run and the CLI
> aborts with `Aborted()` when it opens PGLite. Use the `git clone + bun link` path
> above. Tracking issue: [#218](https://github.com/garrytan/gbrain/issues/218).

## Step 2: API Keys

Ask the user for these:

```bash
export OPENAI_API_KEY=sk-...          # required for vector search
export ANTHROPIC_API_KEY=sk-ant-...   # optional, improves search quality
```

Save to shell profile or `.env`. Without OpenAI, keyword search still works.
Without Anthropic, search works but skips query expansion.

## Step 3: Choose Brain Role, Then Create the Brain

Most installs are a single-user **individual** brain. For a company-wide setup,
do not reuse the same home, database, or markdown repo for a member and the
company aggregate.

```text
individual brain = one user's private/default brain
company brain    = aggregate company brain that imports approved member exports

brain repo       = markdown source of truth
database         = runtime search/index store
```

Use one GBrain code checkout, but separate the knowledge plane:

```text
alice-brain repo     -> Alice individual DB
company-brain repo   -> Company DB
Alice export/pull    -> Company source member-alice
```

For a normal personal install:

```bash
gbrain init --mode individual         # PGLite, no server needed
gbrain doctor --json                  # verify all checks pass
```

The user's markdown files (notes, docs, brain repo) are SEPARATE from this tool repo.
Ask the user where their files are, or create a new brain repo:

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

Read `~/gbrain/docs/GBRAIN_RECOMMENDED_SCHEMA.md` and set up the MECE directory
structure (people/, companies/, concepts/, etc.) inside the user's brain repo,
NOT inside ~/gbrain.

For a company setup, initialize each role separately. The most important rule is
isolation: each role gets its own `GBRAIN_HOME`, database, and markdown repo.

```bash
export ALICE_HOME=/var/lib/gbrain/alice
export COMPANY_HOME=/var/lib/gbrain/company

GBRAIN_HOME="$ALICE_HOME" gbrain init --mode individual --url "$ALICE_DATABASE_URL" --non-interactive
GBRAIN_HOME="$COMPANY_HOME" gbrain init --mode company --url "$COMPANY_DATABASE_URL" --non-interactive
```

Then sync each role's own markdown source of truth:

```bash
GBRAIN_HOME="$ALICE_HOME" gbrain sync --repo /repos/alice-brain --yes
GBRAIN_HOME="$COMPANY_HOME" gbrain sync --repo /repos/company-brain --yes
```

The company brain must not open Alice's repo or database directly. It learns
Alice-approved content only through `gbrain company-share pull`, which imports
into a dedicated source such as `member-alice`.

## Step 3.5: Confirm search mode with the user (DO NOT SKIP)

`gbrain init` auto-applied a default search mode (`tokenmax` unless your subagent
tier is Haiku-class or no OpenAI key is configured). The init output included the
cost matrix below preceded by `[AGENT]` markers. You must NOT silently accept the
default. Stop and ask the operator.

**Present this matrix verbatim:**

```
Per-query cost @ 10K queries/mo (typical single-user volume):

                  Haiku 4.5     Sonnet 4.6    Opus 4.7
                  ($1/M)        ($3/M)        ($5/M)
  conservative    $40/mo        $120/mo       $200/mo
  balanced        $100/mo       $300/mo       $500/mo
  tokenmax        $200/mo       $600/mo       $1,000/mo

(scales linearly: ×10 for 100K/mo, ÷10 for 1K. 25x corner-to-corner spread.
 Natural diagonal pairings — cheap/cheap → frontier/frontier — span ~4x.)
```

**Ask the operator (paraphrase if needed):**

> Your gbrain just installed with search mode `<auto-applied default>`. This is
> a one-time setup decision that controls retrieval payload size. Which mode
> do you want?
>
>   1) conservative — tight 4K budget, no LLM expansion, 10 chunks max.
>      Best for Haiku subagents, cost-sensitive setups, high-volume loops.
>
>   2) balanced — 12K budget, no expansion, 25 chunks. Sonnet-tier sweet spot.
>
>   3) tokenmax (recommended default — preserves v0.31.x retrieval shape) —
>      no budget, LLM expansion ON, 50 chunks. Best for Opus/frontier models.
>
> Cost depends on BOTH the mode AND the downstream model you run. See the
> matrix above for the 9-cell breakdown.

If the operator picks a non-default mode, run:
```bash
gbrain config set search.mode <mode>
```

If they pick tokenmax AND want to preserve the literal v0.31.x default
(limit=20 instead of tokenmax's 50), also run:
```bash
gbrain config set search.searchLimit 20
```

Verify the choice with `gbrain search modes` before continuing.

**Why this matters:** the cost spread between corners of the matrix is 25x.
An agent that silently accepts the default and starts running queries against
a user who didn't expect tokenmax-class context loads can rack up surprise
spend. Confirm before continuing.

## Step 4: Import and Index

```bash
gbrain import ~/brain/ --no-embed     # import markdown files
gbrain embed --stale                  # generate vector embeddings
gbrain query "key themes across these documents?"
```

## Step 4.5: Wire the Knowledge Graph

If the user already had a brain repo (Step 3 imported existing markdown), backfill
the typed-link graph and structured timeline. This populates the `links` and
`timeline_entries` tables that future writes will maintain automatically.

```bash
gbrain extract links --source db --dry-run | head -20    # preview
gbrain extract links --source db                         # commit
gbrain extract timeline --source db                      # dated events
gbrain stats                                             # verify links > 0
```

For brand-new empty brains, skip this step — auto-link populates the graph as the
agent writes pages going forward. There is nothing to backfill yet.

After this step:
- `gbrain graph-query <slug> --depth 2` works (relationship traversal)
- Search ranks well-connected entities higher (backlink boost)
- Every future `put_page` auto-creates typed links and reconciles stale ones

If a user has a very large brain (>10K pages), `extract --source db` is idempotent
and supports `--since YYYY-MM-DD` for incremental runs.

## Step 5: Load Skills

For individual brains, read `~/gbrain/skills/RESOLVER.md`. This is the skill
dispatcher. It tells you which skill to read for any task. Save this to your
memory permanently.

For company brains, read `~/gbrain/skills/COMPANY_RESOLVER.md` instead. Company
mode intentionally exposes a smaller skill surface: query, research/synthesis,
briefing/reporting, maintenance, and guardrails. Personal setup/identity,
skillify, private enrichment, and other user-private workflows stay on the
individual brain side unless an operator explicitly runs them locally.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 6: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 7: Recurring Jobs

Set up using your platform's scheduler (OpenClaw cron, Railway cron, crontab):

- **Live sync** (every 15 min): `gbrain sync --repo ~/brain && gbrain embed --stale`
- **Company share pull** (company brains only, every 15 min): `gbrain company-share pull`
- **Auto-update** (daily): `gbrain check-update --json` (tell user, never auto-install)
- **Dream cycle** (nightly): read `docs/guides/cron-schedule.md` for the full protocol.
  Entity sweep, citation fixes, memory consolidation, plus (v0.23+) overnight conversation
  synthesis and cross-session pattern detection. 8 phases, one cron-friendly command. This
  is what makes the brain compound. Do not skip it.
- **Weekly**: `gbrain doctor --json && gbrain embed --stale`

## Step 8: Integrations

Run `gbrain integrations list`. Each recipe in `~/gbrain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `gbrain integrations doctor` (after at least one is configured)

## Step 8.5: Company Brain Wiring (only for company-wide installs)

On each individual member brain, configure private-by-default sharing:

```bash
GBRAIN_HOME="$ALICE_HOME" gbrain company-share secret set --secret "$ALICE_COMPANY_SHARE_SECRET"
GBRAIN_HOME="$ALICE_HOME" gbrain company-share set-source default --default private
GBRAIN_HOME="$ALICE_HOME" gbrain company-share set-page <slug> --mode summary   # or full/private
```

Register an OAuth client on the individual brain for the company puller, then
register that member on the company brain:

```bash
GBRAIN_HOME="$ALICE_HOME" gbrain auth register-client company-share \
  --grant-types client_credentials \
  --scopes read

GBRAIN_HOME="$COMPANY_HOME" gbrain company-share members add alice \
  --issuer-url https://gbrain-alice.example.com \
  --mcp-url https://gbrain-alice.example.com/mcp \
  --oauth-client-id <alice-client-id> \
  --oauth-client-secret <alice-client-secret> \
  --manifest-secret "$ALICE_COMPANY_SHARE_SECRET"

GBRAIN_HOME="$COMPANY_HOME" gbrain company-share pull --member alice
```

Configure Hermes/OpenClaw against the company brain only unless the agent is
intended to act as a specific user's private assistant:

```text
name: company-gbrain
issuer_url: https://gbrain-company.example.com
mcp_url: https://gbrain-company.example.com/mcp
```

## Step 9: Verify

Read `docs/GBRAIN_VERIFY.md` and run all 7 verification checks. Check #4 (live sync
actually works) is the most important.

## Upgrade

```bash
cd ~/gbrain && git pull origin master && bun install
gbrain init                           # apply schema migrations (idempotent)
gbrain post-upgrade                   # show migration notes for the version range
```

Then read `~/gbrain/skills/migrations/v<NEW_VERSION>.md` (and any intermediate
versions you skipped) and run any backfill or verification steps it lists. Skipping
this is how features ship in the binary but stay dormant in the user's brain.

**v0.32.3 search modes (one-time upgrade prompt):** if the user's brain was
created before v0.32.3, `gbrain post-upgrade` prints a banner including the
9-cell cost matrix (mode × downstream model) preceded by `[AGENT]` markers.
**Do NOT silently move past the banner.** Present the matrix to the operator
verbatim, ask which mode they want (recommended default: `tokenmax` to preserve
v0.31.x retrieval shape), then run `gbrain config set search.mode <mode>`. See
Step 3.5 above for the full ask-the-user protocol — the upgrade path uses the
same matrix and same default.

For v0.12.0+ specifically: if your brain was created before v0.12.0, run
`gbrain extract links --source db && gbrain extract timeline --source db` to
backfill the new graph layer (see Step 4.5 above).

For v0.12.2+ specifically: if your brain is Postgres- or Supabase-backed and
predates v0.12.2, the `v0_12_2` migration runs `gbrain repair-jsonb`
automatically during `gbrain post-upgrade` to fix the double-encoded JSONB
columns. PGLite brains no-op. If wiki-style imports were truncated by the old
`splitBody` bug, run `gbrain sync --full` after upgrading to rebuild
`compiled_truth` from source markdown.
