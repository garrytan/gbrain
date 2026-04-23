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

**SECURITY: Do NOT collect API keys inside the agent chat.** Any command the user runs
in an agent session (Claude Code, OpenClaw, Hermes) is stored in conversation logs.
If the agent tells the user to run `export OPENAI_API_KEY="sk-..."` in the chat, the
key ends up in the logs. This is a conflict: gbrain needs the keys, but the agent
session is not a safe place to enter them.

**Instead, tell the user to set keys in a separate terminal:**

```bash
# Tell the user: "Open a separate terminal (not this chat) and run:"
echo 'export OPENAI_API_KEY="sk-..."' >> ~/.zshenv
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshenv
source ~/.zshenv
```

**Then verify keys are available without printing them:**

```bash
[ -n "$OPENAI_API_KEY" ] && echo "OpenAI key: set" || echo "OpenAI key: missing"
[ -n "$ANTHROPIC_API_KEY" ] && echo "Anthropic key: set" || echo "Anthropic key: missing"
```

If keys are missing, remind the user to set them in a separate terminal and restart
the agent session (new sessions inherit shell environment variables).

**If the user asks "should I just paste it here?"** — say NO. Explain:
"This chat logs everything to the provider's servers. Set the key in a separate
terminal instead so it never enters the conversation."

**If the user asks why:** "Everything you type in an AI agent chat is stored in
conversation logs on the provider's servers. An API key in the chat is like writing
your password on a whiteboard in a shared office — it's probably fine, but you
wouldn't do it on purpose."

**If the user pastes an API key directly in the chat anyway**, immediately warn them:
"That key is now in the conversation log. Please rotate it (delete and create a new one)
at platform.openai.com → API Keys, then set the new key in a separate terminal."

OpenAI is required for vector search. Anthropic is optional (improves search quality).
Without OpenAI, keyword search still works. Without Anthropic, search works but skips
query expansion.

## Step 3: Create the Brain

```bash
gbrain init                           # PGLite, no server needed
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

Read `~/gbrain/skills/RESOLVER.md`. This is the skill dispatcher. It tells you which
skill to read for any task. Save this to your memory permanently.

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
- **Auto-update** (daily): `gbrain check-update --json` (tell user, never auto-install)
- **Dream cycle** (nightly): read `docs/guides/cron-schedule.md` for the full protocol.
  Entity sweep, citation fixes, memory consolidation. This is what makes the brain
  compound. Do not skip it.
- **Weekly**: `gbrain doctor --json && gbrain embed --stale`

## Step 8: Integrations

Run `gbrain integrations list`. Each recipe in `~/gbrain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `gbrain integrations doctor` (after at least one is configured)

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

For v0.12.0+ specifically: if your brain was created before v0.12.0, run
`gbrain extract links --source db && gbrain extract timeline --source db` to
backfill the new graph layer (see Step 4.5 above).

For v0.12.2+ specifically: if your brain is Postgres- or Supabase-backed and
predates v0.12.2, the `v0_12_2` migration runs `gbrain repair-jsonb`
automatically during `gbrain post-upgrade` to fix the double-encoded JSONB
columns. PGLite brains no-op. If wiki-style imports were truncated by the old
`splitBody` bug, run `gbrain sync --full` after upgrading to rebuild
`compiled_truth` from source markdown.
