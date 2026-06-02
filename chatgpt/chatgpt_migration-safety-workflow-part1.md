---
title: "Migration safety workflow"
type: essay
created: 2025-12-11
updated: 2025-12-12
source: chatgpt-export
conversation_id: 693b44bb-e970-832c-8dc0-d51da3db1750
message_count: 18
tags: [chatgpt, import, code, long-form]
---
# Migration safety workflow

> Conversation ID: 693b44bb-e970-832c-8dc0-d51da3db1750
> Created: 2025-12-11T22:25:00Z
> Updated: 2025-12-12T20:42:33Z
> Messages: 18


Explain to me migration safety and stuff. So I basically have three databases on NEON. I have a permanent production database. Then off of that I make a child branch database called main that is also permanent. And then off of that I have a development database off of production that is permanent. It's a child of production. And I'll, you know, flash the development database and whatnot. Whatever. And I'm working. Basically have CI automatically when I push my stuff from local to main. It goes to staging site preview.jov.ie. It's my staging site. And on that site it has the development server. I don't... I don't know. Anyway. And so I will do my work on main. And then... Or I'll do my work on dev. And then I'll open a new branch. We'll commit it. We'll PR. And then we'll merge into main. And then it has to pass some checks in CI. And then if it passes all those, it goes to... It goes to... Opens up a PR. Automatically opens up a PR to production. And before it can get merged into production, it's got to pass some checks. And the checks for production. If it... If it passes the checks for production. And then production has a... Production is synced to the production. And in CI it does the migrations. And if it passes all the checks on that PR, then it gets merged to... And then we manually go in and merge it to production. And then our production database becomes like that. And... And then if our production database is set, we go in and we open up... If our production database is set, then we will open up a... Then we'll open that PR. We'll open it up here and merge it. And merge the PR into production. And then it will deploy and do our migrations. My question is, we're using Drizzle and Neon serverless. And... And, you know, Drizzle kit. And my question is just, like, I'll do a lot of work with AI agents locally. And then I'll push the things. And... It just seems like I have a lot of issues happening with, like, migration. It's coming out of... Like, in theory, this should all be linear. And therefore, there should never be migrations out of sync. But for some reason, it seems like my migrations are actually having a lot of things where it's like... Oh, we actually accidentally sent something to be concurrently. But it shouldn't be concurrently or whatever. And we, like, you know, we'll modify the migration. Because it hasn't gotten to production yet. But then, like, or we don't. Or we add another migration. I don't know. I just... It seems like, logically, we should have guardrails in place where, like, we're not committing... Like, any time anything hits main, it's already good to, like... I don't know. The migrations just shouldn't fall out of sync. And there shouldn't be situations where I have to push custom SQL. But it seems like every time I'm working with AI agents, it's like they're constantly asking me to push custom SQL to, like, deal with, like... Oh, a column is missing something. And we already have that in the migration. But for some reason, it didn't... You know what I mean? Like, help me just roll out exactly how this should be done so that I never have to deal with this again. Because as soon as we launch, I can't just refresh our production database. You know what I mean? Like, I can't touch our production database anymore. So I need to be in a situation where I can easily be pushing code multiple times a day and getting it through CI and up to production. But not have to worry about database shit. Have the database migrations automatically happening. And I, like, speed is important here because we're, like, YC-style startup. But it seems like we can't move very quickly because it's taking hours of my day just to do pushes and PRs and stuff and deal with migrations. So help me out with that.


Short version, Mr. White: your *idea* of “everything is linear so migrations can’t drift” is correct — but your current setup breaks that assumption in a few key places:

- AI is writing SQL/migrations in ways that bypass your “one source of truth”.
- Multiple long-lived DB branches share schema but not history.
- You’re sometimes editing or bypassing migrations that have already been applied somewhere.

Let me give you a concrete, opinionated workflow for **Drizzle + Neon** that keeps prod safe and makes migrations boring.

---

## 1. Mental model: what “safe migrations” actually means

Four rules:

1. **Single source of truth**  
   - Your source of truth is:  
     **TypeScript schema → generated migration files → DB**.  
   - Not “whatever is in the DB right now”. Drizzle explicitly wants schema in TS as the source of truth for migrations. citeturn1search9turn1search16  

2. **Migrations are immutable once applied to any shared DB**  
   - If a migration has ever run on dev/main/prod: you **never edit that file**.  
   - If it’s wrong, you fix it with a *new* migration, never by editing the old one.

3. **No raw SQL on long-lived DBs**  
   - The only thing that changes schema on `dev/main/prod` is `drizzle-kit migrate` running the committed migration files.
   - If you run custom SQL, it must live **inside a migration file**, not pasted into psql.

4. **Each environment’s DB matches a Git branch**  
   - A branch’s DB is just: “`drizzle/migrations` applied in order”.  
   - Drift happens when a DB is changed by something *other than* those files, or those files are changed after being applied.

Everything below is just how to enforce these rules.

---

## 2. Diagnose what’s biting you now

From what you described:

- You have **one shared dev branch** off production, and **one main branch** off production.
- You “flash” dev, do schema stuff there, AI agents sometimes suggest **direct SQL** changes.
- You sometimes **edit migrations that haven’t hit prod yet** or add more migrations on top, then push/merge in different orders.
- CI runs migrations on main and prod, but the state of `_drizzle_migrations` vs the actual files can diverge.

Common failure paths in that pattern:

1. **Editing a migration after it was already applied to dev**  
   - `_drizzle_migrations` table says “did migration 0005.sql”.  
   - You change 0005.sql in Git.  
   - Now dev DB has version A of 0005, main/prod will see version B of 0005. They are no longer logically the same schema.

2. **AI runs raw SQL that’s never recorded in a migration**  
   - Dev has column X because AI added it.  
   - Migration files don’t know about that exact history.  
   - Later `drizzle-kit generate` diffs from your TS schema and produces weird/duplicative SQL.

3. **Multiple feature branches generating migrations in parallel**  
   - Branch A creates `0007_add_users_field.sql`.  
   - Branch B also creates `0007_add_orders_field.sql`.  
   - When you merge both, file order / content becomes non-linear unless you rebase and regenerate.  
   - Drizzle has a `check` command specifically to detect migration collisions. citeturn1search16  

We can mostly eliminate this by tightening your workflow and isolating AI.

---

## 3. Pick one Drizzle workflow and *stick to it*

Drizzle supports several flows (`push`, `generate` + `migrate`, etc.). For a YC-style SaaS with real production, I’d recommend:

> **Schema-first with generated SQL migration files**  
> (`drizzle-kit generate` → commit files → `drizzle-kit migrate` in CI)

From the docs: Drizzle is fine with code-first schemas where you generate SQL migrations and apply them via `drizzle-kit migrate`. citeturn1search0turn1search16  

Concretely:

- **You and AI edit only the TS schema** (`src/db/schema.ts` etc.).
- To change schema:
  1. Modify TS schema.
  2. Run `drizzle-kit generate`.
  3. Run `drizzle-kit migrate` against your local dev DB / Neon feature branch.
  4. Commit:
     - updated TS schema
     - new files in `drizzle/` migrations folder
- CI’s only job: **`drizzle-kit migrate` using those committed files**, never `push`, never autogenerated stuff at runtime.

Don’t mix `push` and `generate/migrate` flows on the same project; that’s another subtle source of chaos. citeturn1search0turn1search16  

---

## 4. Shape your Neon branching to match your Git flow

Right now you’ve got:

- Neon: `prod` (parent) → `main` child → `dev` child.

I’d change the mental model to something like:

- **Neon prod branch**  ↔ Git `production` branch  
- **Neon staging / main branch**  ↔ Git `main` branch  
- **Ephemeral PR branches**  ↔ Git feature branches / PRs

Neon *wants* you to use lots of cheap, short-lived branches (branch per PR / per feature). citeturn1search1turn1search17turn1search3  

### Recommended pattern

1. **Prod**
   - Neon branch: `prod`
   - Git branch: `production`
   - CI: on merge to `production`
     - Run `drizzle-kit migrate` against Neon `prod`.
     - Run smoke tests.

2. **Staging (your `main`)**
   - Neon branch: `staging` (or `main-db`) branched from `prod`.
   - Git branch: `main`
   - CI: on push/merge to `main`
     - Run `drizzle-kit migrate` against Neon `staging`.
     - Run full integration tests hitting `preview.jov.ie`.

3. **Per-PR / feature branches**
   - On PR from `feature/*` → `main`:
     - GitHub Action:
       - Create Neon branch from `staging` or `prod`.
       - Run `drizzle-kit migrate` against that Neon branch.
       - Run tests.
       - Destroy the branch when PR closes. citeturn1search3turn1search6  
   - That means “AI goes wild” on its own Neon branch, not on a shared dev DB.

Critically: **no more shared long-lived “dev DB” where random untracked SQL and half-baked migrations accumulate**. Every feature works on its own DB branch created from a clean parent.

---

## 5. Concrete guardrails to add **right now**

### 5.1. Forbid mutation of existing migrations

Add a pre-commit / lint rule and a culture rule:

- Once a migration is merged to `main`, treat all files in `drizzle/` as **append-only**:
  - You can add new files.
  - You can’t change existing ones (except in a PR that hasn’t been merged *and* the migration has never been applied to any shared DB).

Technically, you can enforce this:

- Pre-commit hook that:
  - If branch is not `initial` and you’re not rebasing a brand-new project:
    - Fails if any existing file in `drizzle/` is modified instead of new ones being created.

Or simpler: a team rule + code review: “changing an existing migration is an automatic ‘no’ review comment.”

---

### 5.2. Ban raw schema-changing SQL on non-ephemeral DBs

- Only allowed places for schema-changing SQL:
  - inside migration files generated by `drizzle-kit generate` (that you then edit manually if needed)
  - or an **extra migration file** you hand-write and commit.

- On prod/staging:
  - No `ALTER TABLE` in psql.
  - No AI agent talking directly to prod/staging DB credentials.
  - If a patch truly must be manual (rare emergency), you:
    - Create a migration with the exact same SQL.
    - Apply it via `drizzle-kit migrate` so history stays consistent.

If you want AI help, have it generate SQL **into a new migration file in the repo**, not into the DB.

---

### 5.3. Restrict what AI agents are allowed to do

This is probably the root of your weirdness.

**AI permission model**:

- Allowed:
  - Editing TypeScript schema files.
  - Generating *new* migrations via `drizzle-kit generate`.
  - Writing *suggested* SQL inside *new* migration files (you review them).
- Not allowed:
  - Editing existing migrations.
  - Connecting to Neon prod / staging with write access.
  - Running `drizzle-kit push` against any shared DB.
  - Running ad-hoc SQL against non-ephemeral DBs.

If you integrate AI deeply, consider a dedicated **“agent playground” Neon branch** (ephemeral, periodically nuked). It never becomes prod; it’s just where the agent gets to experiment before you cherry-pick the good ideas into proper migrations. Neon’s copy-on-write branches are cheap enough for this. citeturn1search13turn1search1  

---

### 5.4. Add CI checks so “out of sync” fails early

In CI, for `main` and `production`:

1. **Migration drift check**
   - Step 1: `drizzle-kit migrate` against the target DB.
   - Step 2: fail if:
     - there are unapplied migrations, or
     - `drizzle-kit` reports collisions / inconsistencies.
   - Optionally: `drizzle-kit check` to detect migration race conditions in the repo itself. citeturn1search16  

2. **Schema consistency check (optional but nice)**  
   Pattern:
   - Use `drizzle-kit pull` or Postgres introspection in CI to get the actual DB schema.
   - Compare with generated Drizzle schema (or at least confirm that running `drizzle-kit generate` produces no diff other than `drizzle/`).

If any of these fail → PR blocked. That’s the guardrail you’re asking for: “anything that hits main is already safe to deploy to prod”.

---

## 6. A “happy path” deployment timeline

Let’s walk your flow in the “ideal world” where these rules are in place.

### 6.1. You build a feature locally

1. Git: branch off `main`: `feature/add-teams`.
2. Neon:
   - CI (or a script) creates Neon branch `feature-add-teams-db` from `staging` or `prod`.
3. Locally:
   - `.env` points to `feature-add-teams-db`.
4. You / AI:
   - Edit TS schema.
   - Run `drizzle-kit generate`.
   - Run `drizzle-kit migrate`.
   - App boots, DB updated. You iterate.
5. You commit:
   - code changes,
   - TS schema changes,
   - new migration file(s).

### 6.2. You open PR → `main`

CI on this PR:

1. Rebuilds container / app.
2. Applies migrations to the Neon branch for this PR:
   - `drizzle-kit migrate` on `feature-add-teams-db`.
3. Runs tests against that DB.
4. Optionally:
   - `drizzle-kit check` to detect collisions.
5. If green, you merge into `main`.

### 6.3. `main` deployment (staging)

CI on `main`:

1. `drizzle-kit migrate` against Neon `staging`.
2. Run tests, smoke, etc.
3. If all good, it auto-opens a PR to `production` (your current pattern).

### 6.4. `production` deployment

CI on merge to `production`:

1. `drizzle-kit migrate` against Neon `prod`.
2. Smoke tests.
3. If green, done. No manual SQL, no surprises.

At any point, if a migration is wrong:

- You **do not edit the old migration**.
- You create a new migration that fixes it:
  - e.g. `0009_fix_wrong_default_on_users_name.sql`.
- That new file goes through the same pipeline.

---

## 7. What to do with your current mess

Practically:

1. **Freeze manual SQL on prod/staging right now.**
2. Pick a moment and:
   - Dump prod schema.
   - Ensure your Drizzle TS schema matches reality (worst case, use `drizzle-kit pull` once to reset and then switch back to schema-first from there). citeturn1search0turn1search16  
3. Generate a “baseline” migration:
   - Everything before today is considered “baseline”; from now on, migrations are strictly append-only.
4. Refactor CI:
   - Add a migration step that fails if anything is off.
   - Wire up Neon branch creation for PRs.
5. Put AI in a sandbox and give it **no credentials** for prod/staging.

---

If you want, in your next message paste:

- your `drizzle.config.ts`
- how you currently call drizzle-kit in CI  
and I can rewrite the exact CI scripts and a Neon branching diagram tailored to your repos, so you can just drop it in and be done with the migration drama.


How can I... I have NEON HDD installed, and I'm using Windsurf with Cascade for my coding. How can I set the DB, like so for my workflow you're saying use short-lived database branches that match my feature. How can I get NEON to set or get my AI to set that database and a new branch like can you give me like a slash command or something or like is there a hook because it has Cascade hooks. Can we force Cascade to basically like every time I ask it to build something to spin up a new branch, pull, spin up a new DB matching that branch and then set that DB in the environmental variables or like does NEON have a way to handle auto setting the DB because it seems like a pain in the ass to actually copy that every time you want to. Does NEON CLI or NEON MCP have like a way to handle that?


Yeah, you can absolutely make this not-a-huge-pain, Mr. White.  
There are basically **two building blocks** you can combine:

1. **Neon tools** (CLI + Neon Local + MCP)
2. **Windsurf tools** (Cascade MCP + Cascade Hooks)

I’ll show you a concrete way to get to:

> “Type `/db-branch feature-x` → Neon branch gets created → app `.env` points at it → AI keeps coding against that DB.”

---

## 1. Use Neon Local so you *stop* manually swapping URLs

What you’re calling “Neon HDD” is almost certainly **Neon Local Connect** (their local daemon / extension). It’s designed exactly to remove the “copy/paste connection string” problem:

- You set your app to talk to a **static** URL like  
  `postgres://neon:npg@localhost:5432/<dbname>`
- Neon Local routes that to **whatever branch is active**.
- The extension lets you **create & switch branches from the editor** and even create ephemeral branches. citeturn0search4  

So first simplification:

- In your project `.env` (or whatever Drizzle uses), set:
  ```env
  DATABASE_URL="postgres://neon:npg@localhost:5432/yourdb"
  ```
- Stop ever changing that. All per-branch switching is handled by Neon Local.

Now all you need is: **“How do I get Cascade to make + switch Neon branches for me?”**

---

## 2. Option A – Neon CLI + Cascade Hooks (DIY “slash command”)

Neon CLI gives you exactly what you want:

- `neon branches create --name <branch> --parent <parent>` – create a branch (CI-style, works great for ephemeral feature branches). citeturn0search0  
- `neon connection-string <branch>` – get the connection string if you *do* want to write it into `.env` directly. citeturn0search7  

And Cascade Hooks let you run **shell commands when a prompt comes in**, including on `pre_user_prompt`. citeturn0search3  

Put those together → you can fake a **slash command**.

### 2.1. Small script to create/switch a Neon branch

Create `scripts/neon_feature_branch.sh` in your repo:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: neon_feature_branch BRANCH_NAME [PARENT_BRANCH]" >&2
  exit 1
fi

BRANCH_NAME="$1"
PARENT="${2:-staging}"        # or "main" or "production", your call
PROJECT_ID="your-project-id"  # or omit if you only have one project

# 1) Create branch (if it already exists, we just ignore the error)
neon branches create \
  --name "$BRANCH_NAME" \
  --parent "$PARENT" \
  --project-id "$PROJECT_ID" \
  --output json >/tmp/neon-branch.json 2>/dev/null || true

# 2) If you're using Neon Local, you don't have to touch DATABASE_URL.
# You just need Neon Local to route to this branch. Easiest is to open
# the Neon Local UI and select this branch manually, or script it later.

echo "Created / ensured Neon branch '$BRANCH_NAME' from parent '$PARENT'."
```

Make it executable:

```bash
chmod +x scripts/neon_feature_branch.sh
```

> If you *weren’t* using Neon Local, you could also do:
> ```bash
> CONN_STRING=$(neon connection-string "$BRANCH_NAME" --project-id "$PROJECT_ID" --pooled)
> # Then overwrite DATABASE_URL in .env.* with that value
> ```
> But with Neon Local, you can skip this and let `localhost:5432` handle it.

---

### 2.2. Hook that script up to a “/db-branch” pseudo-command

Create `.windsurf/hooks.json` at your repo root (workspace-level hooks): citeturn0search3  

```json
{
  "hooks": {
    "pre_user_prompt": [
      {
        "command": "python3 .windsurf/db_branch_hook.py",
        "working_directory": "."
      }
    ]
  }
}
```

Then create `.windsurf/db_branch_hook.py`:

```python
#!/usr/bin/env python3
import sys, json, re, subprocess

def main():
    data = json.loads(sys.stdin.read())
    prompt = data.get("tool_info", {}).get("user_prompt", "")

    # Pattern: /db-branch feature-name [parent-branch]
    m = re.match(r"^/db-branch\s+(\S+)(?:\s+from\s+(\S+))?", prompt.strip())
    if not m:
        # Not our command – let Cascade handle it normally
        sys.exit(0)

    branch = m.group(1)
    parent = m.group(2) or "staging"  # or main/production/etc.

    try:
        subprocess.check_call(
            ["bash", "scripts/neon_feature_branch.sh", branch, parent]
        )
        # Optional: print to stderr so *you* see it in Windsurf
        print(f"[hook] Created Neon branch '{branch}' from '{parent}'", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"[hook] Failed to create branch: {e}", file=sys.stderr)
        # Block the prompt so Cascade doesn't try to "answer" it
        sys.exit(2)

    # Block the user prompt so it doesn't go to Cascade as a normal question
    sys.exit(2)

if __name__ == "__main__":
    main()
```

What this gives you:

- In Cascade, you type:
  ```text
  /db-branch feat-ai-search from staging
  ```
- The `pre_user_prompt` hook sees that pattern, runs your script, creates the Neon branch, and then **blocks** the prompt from going to the model (exit code 2). citeturn0search3  
- Your app keeps using `postgres://neon:npg@localhost:5432/...` and Neon Local routes to whichever branch you pick in its UI. If you want to fully automate the switching via CLI, that’s a 2nd step (but many teams just click the branch in the Neon Local panel).

This is the “no MCP, no magic” path: just **Neon CLI + Hooks**.

---

## 3. Option B – Let Cascade call Neon directly via MCP

If you want your AI to both **create branches and reason about them**, Neon now ships an official **Neon MCP Server** that exposes tools for:

- creating/listing/deleting branches
- running SQL
- schema diffs / migrations, etc. citeturn0search1turn0search11turn0search17turn0search21  

Windsurf has built-in MCP support; you configure servers via `~/.codeium/windsurf/mcp_config.json`. citeturn0search15turn0search1  

Example config (local MCP server):

```json
{
  "mcpServers": {
    "neon": {
      "command": "npx",
      "args": [
        "-y",
        "@neondatabase/mcp-server-neon",
        "start",
        ""
      ],
      "env": {
        "NEON_API_KEY": "<YOUR_NEON_API_KEY>"
      }
    }
  }
}
```

Once that’s installed:

- Cascade sees the **Neon MCP tools**.
- In a Windsurf **Rule** for this workspace, you tell Cascade something like:

> “When starting work on a new feature, create a new Neon branch from `staging` using the Neon MCP tools, name it `feat-<short description>`, and then write the appropriate DATABASE_URL (Neon Local `localhost` URL) into `.env.local` if needed.”

Because MCP tools are callable directly from the model, you can literally say in Cascade:

> “For this task, create a fresh Neon database branch off `staging`, then run migrations, and use that branch for all queries.”

and it will use the Neon MCP tools to do that. citeturn0search1turn0search21  

**Caveat:** MCP can’t magically “set env vars” in your shell – it still has to **edit files** (like `.env`) or run commands through the terminal tool. So the pattern is:

1. MCP `create branch`.
2. MCP `get connection info`.
3. Cascade uses the **terminal tool** to edit `.env` / `drizzle.config.ts` / etc.  
   (or just rely on Neon Local’s static `localhost` URL as above).

---

## 4. What I’d actually do in your shoes

To keep this sane and fast for a YC-style cadence:

1. **Lock in Neon Local:**
   - Single `DATABASE_URL=postgres://neon:npg@localhost:5432/appdb` for all dev.
   - No more manual URL swapping.

2. **Add the CLI hook “slash command”:**
   - `scripts/neon_feature_branch.sh` + `.windsurf/hooks.json` + `db_branch_hook.py`.
   - Flow: `/db-branch feat-ai-agents from staging` → branch exists; Neon Local can now be pointed to it.

3. (Nice to have) **Bring in Neon MCP**:
   - Install Neon MCP server in Windsurf via `mcp_config.json`.
   - Add workspace Rules telling Cascade to use Neon tools for DB work, *never* raw SQL against prod, etc.
   - Let it help with creating branches, running sanity-check queries, monitoring migrations, etc.

That setup gives you:

- Short-lived Neon branches matching your feature branches.
- One stable local connection string.
- A pseudo slash-command in Cascade to spin up DB branches on demand.
- A clean separation: AI can orchestrate Neon via MCP, but your **source of truth** for migrations is still your Git + Drizzle pipeline.

If you tell me:

- the exact env var name Drizzle is reading (`DATABASE_URL` vs `PGDATABASE_URL` etc.),
- and where your `.env` lives in the repo,

I can rewrite the sample script to target *exactly* your file + var name so you can drop it in and go.


DATABASE_URL is our drizzle env var name
The env is in the root .env.local


Perfect, that’s exactly what I needed, Mr. White.  
Let’s wire this up *specifically* for:

- `DATABASE_URL`
- stored in repo-root `./.env.local`
- with Neon + Windsurf + Cascade

I’ll give you two modes:

1. **Simple mode (recommended): static localhost URL via Neon Local**  
2. **Dynamic mode: script that creates a Neon branch *and* rewrites `.env.local`**

You can pick one or even support both.

---

## 1. Simple mode – one static URL, Neon handles the branch

If you’re happy to let **Neon Local** handle routing to the active branch, you never need to touch `DATABASE_URL` again.

### 1.1. Set `.env.local` once

In your repo root `.env.local`:

```env
DATABASE_URL="postgres://neon:npg@localhost:5432/appdb"
```

(Replace `appdb` with whatever Neon Local expects; often it’s ignored, but use your real DB name for sanity.)

Drizzle will always read from that env var. No more per-branch URL juggling.

### 1.2. Use a hook to just create the Neon branch

From here, all your Cascade/CLI integration has to do is:

- Create a Neon branch for your feature (via Neon CLI or MCP).
- You then select that branch in the Neon Local UI (or later script that if the CLI exposes it).

You can still keep the `/db-branch feat-x` pseudo-command, but it only needs to *create* the branch, not edit `.env.local` at all.

---

## 2. Dynamic mode – create branch **and** update `.env.local`

If you’d rather your AI switches `.env.local` automatically, here’s a concrete setup using:

- **Neon CLI**
- **`DATABASE_URL` in `./.env.local`**
- **Cascade pre_user_prompt hook** to implement `/db-branch ...`

### 2.1. Bash script: create branch + update `.env.local`

Create `scripts/neon_feature_branch.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: neon_feature_branch BRANCH_NAME [PARENT_BRANCH]" >&2
  exit 1
fi

BRANCH_NAME="$1"
PARENT="${2:-staging}"        # default parent branch in Neon
PROJECT_ID="YOUR_NEON_PROJECT_ID"  # put your actual project id here

# 1) Create branch (idempotent: if exists, we don't fail)
echo "[neon] Ensuring branch '$BRANCH_NAME' (parent: '$PARENT')..."
neon branches create \
  --name "$BRANCH_NAME" \
  --parent "$PARENT" \
  --project-id "$PROJECT_ID" \
  --output json >/tmp/neon-branch.json 2>/dev/null || true

# 2) Get a pooled connection string for that branch
echo "[neon] Fetching connection string for branch '$BRANCH_NAME'..."
CONN_STRING="$(
  neon connection-string \
    --project-id "$PROJECT_ID" \
    --branch "$BRANCH_NAME" \
    --pooled
)"

if [ -z "$CONN_STRING" ]; then
  echo "[neon] Failed to obtain connection string" >&2
  exit 1
fi

ENV_FILE=".env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "[neon] $ENV_FILE not found. Creating it."
  touch "$ENV_FILE"
fi

# 3) Update DATABASE_URL in .env.local
if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  # replace existing line
  sed -i.bak "s|^DATABASE_URL=.*$|DATABASE_URL=\"$CONN_STRING\"|" "$ENV_FILE"
else
  # append new line
  echo "DATABASE_URL=\"$CONN_STRING\"" >> "$ENV_FILE"
fi

echo "[neon] Set DATABASE_URL in $ENV_FILE to:"
echo "        $CONN_STRING"
```

Notes:

- Uses `neon branches create` and `neon connection-string` from the Neon CLI. citeturn0calculator0  
- Idempotent: re-running for the same branch name doesn’t blow up.
- Updates `DATABASE_URL` *only* in `./.env.local`.

Make it executable:

```bash
chmod +x scripts/neon_feature_branch.sh
```

---

### 2.2. Windsurf Cascade hook: `/db-branch feat-x from parent`

Add `.windsurf/hooks.json` to your repo:

```json
{
  "hooks": {
    "pre_user_prompt": [
      {
        "command": "python3 .windsurf/db_branch_hook.py",
        "working_directory": "."
      }
    ]
  }
}
```

Now create `.windsurf/db_branch_hook.py`:

```python
#!/usr/bin/env python3
import sys, json, re, subprocess

def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        # If the input is weird, just let Cascade handle the prompt
        sys.exit(0)

    prompt = data.get("tool_info", {}).get("user_prompt", "")
    if not isinstance(prompt, str):
        sys.exit(0)

    # Pattern: /db-branch feature-name [from parent-branch]
    # examples:
    #   /db-branch feat-ai-agents
    #   /db-branch feat-ai-agents from staging
    m = re.match(r"^/db-branch\s+(\S+)(?:\s+from\s+(\S+))?$", prompt.strip())
    if not m:
        # Not our command – let Cascade process normally
        sys.exit(0)

    branch = m.group(1)
    parent = m.group(2) or "staging"

    try:
        subprocess.check_call(
            ["bash", "scripts/neon_feature_branch.sh", branch, parent]
        )
        print(
            f"[hook] Created Neon branch '{branch}' from '{parent}' and updated .env.local",
            file=sys.stderr,
        )
    except subprocess.CalledProcessError as e:
        print(f"[hook] Failed to create branch: {e}", file=sys.stderr)
        # Block this prompt; user will see the error in terminal
        sys.exit(2)

    # Exit code 2 => block this prompt from going to Cascade as a normal chat
    sys.exit(2)

if __name__ == "__main__":
    main()
```

Behavior:

- In Windsurf, you type:
  ```text
  /db-branch feat-ai-search from staging
  ```
- Hook fires **before** Cascade sees the prompt.
- It:
  - Creates `feat-ai-search` branch in Neon (if needed).
  - Fetches new connection string.
  - Writes it into `./.env.local` as `DATABASE_URL=...`.
- The prompt is blocked (exit code 2), so Cascade doesn’t try to “answer” it.

From that point on:

- Drizzle uses the new `DATABASE_URL`.
- Your tests / `drizzle-kit migrate` / dev server all hit that feature branch DB.

---

## 3. How to plug this into your workflow

**Typical flow:**

1. `git switch -c feat-ai-search`
2. In Windsurf chat:
   ```text
   /db-branch feat-ai-search from staging
   ```
3. Then:
   ```text
   Build the DB schema / migrations for <feature>, run migrations, and update the code accordingly.
   ```
   Cascade uses the new `DATABASE_URL` in `.env.local`, Drizzle hits the new Neon branch.

**When you’re done:**

- Merge your PR.
- Optionally add a cleanup script to delete old Neon branches on PR close (CI).

---

## 4. Which mode should you actually use?

If you want **least friction**:

- Use **Simple mode**:
  - Fix `DATABASE_URL` in `.env.local` to the Neon Local URL.
  - Use the CLI + hook only to create Neon branches.
  - Switch active branch via Neon Local UI.

If you want **“hands free” env switching for the AI**:

- Use **Dynamic mode**:
  - Keep the script + hook above.
  - Let `/db-branch` both create the Neon branch and overwrite `DATABASE_URL`.

Either way, your migration safety story from earlier still holds: per-feature branches, Drizzle migrations only, no raw SQL touching prod/staging.

---

If you paste your current `drizzle.config.*` in the next message, I can also wire this into a `package.json` script like `pnpm db:migrate:feature` that Cascade can run automatically after the `/db-branch` command so the whole thing is one shot.


I want a workflow where I can work solo (no other devs on the project) and just do a ton of work with local AI agents. And fire off a simple slash command or have a cascade hook to have the agents fix all errors and commit and push and have it merge to main and I can keep working.

Whats the best way to handle this without losing moment by doing long push pr merge switch to main branch out start work cycles


Got you, Mr. White — you basically want:

> “I hack with AI locally → one command → everything is fixed, committed, pushed to **main** → CI runs → I keep coding without branch/PR brain damage.”

Totally doable **without** wrecking your DB or prod, if you structure things right.

---

## 1. Big-picture setup (optimized for *solo*, fast, safe-ish)

For your situation I’d simplify to this:

### Git branches

- `main`  
  - **You always work here locally.** No feature branches unless you explicitly want one.
  - Every push to `main` runs CI + migrations on a **staging DB** and deploys to `preview.jov.ie`.

- `production`  
  - Protected branch.
  - CI runs migrations against **prod DB**, then deploys production.
  - Either:
    - Auto-create PR from `main` → `production` and you click “Merge”, or
    - Auto-merge if CI is green (when you’re confident).

### Neon / DB branches

- **Neon branch `prod`**  
  - Maps to `production` Git branch.

- **Neon branch `staging`**  
  - Maps to `main` Git branch. CI runs `drizzle-kit migrate` here on every push to `main`.

- **Neon branch `dev-main`** (optional but nice)  
  - Your local dev DB. You can nuke/refresh this freely since it’s not prod/staging.

Local dev uses **one stable connection string** (Neon Local or a fixed staging/dev URL). You’re not juggling DB URLs per feature; you’re just editing code + schema and letting migrations do their job.

---

## 2. What you want from Windsurf / Cascade

You basically want a **“/ship” button** that does this:

1. Make sure the repo is in a good state:
   - Format / lint.
   - Run tests.
   - Run `drizzle-kit generate` + `drizzle-kit migrate` (against your dev Neon branch).
2. If things fail → fix them using AI, iteratively, until everything passes.
3. Once green:
   - `git add -A`
   - `git commit -m "<AI-generated message>"`
   - `git push origin main`

The good news: Cascade **Workflows** were designed exactly for “multi-step, repetitive flows” that you trigger with a `/name` slash command. citeturn0search6turn0search8  

So:

- Use **Cascade Workflows** for “/ship”.
- Optionally combine with **Cascade Hooks** for low-level stuff (but Workflows are the clean way for what you’re describing).

---

## 3. Define a `/ship` Workflow

Create a workflow file, e.g.:

`./.windsurf/workflows/ship.md` citeturn0search6turn0search12  

Example:

```markdown
---
title: Ship changes to main
description: |
  For solo dev. Fix all local issues, ensure tests & migrations pass,
  then commit and push to origin/main.
---

# Step 1 – Ensure repo is clean and tests/migrations pass

You are managing a TypeScript/Next.js app with Drizzle and Neon.
Use the terminal tool to run, in this order:

1. `pnpm lint`
2. `pnpm test`
3. `pnpm db:generate` (this should run `drizzle-kit generate` for any schema changes)
4. `pnpm db:migrate` (runs `drizzle-kit migrate` against the local/dev Neon DB)

If any of these commands fail:

- Read the error output.
- Locate the relevant files.
- Apply code changes to fix the issue.
- Re-run the failing command until it passes.

Repeat this process until ALL of the following pass successfully:

- `pnpm lint`
- `pnpm test`
- `pnpm db:generate`
- `pnpm db:migrate`

# Step 2 – Create a commit

Once all checks pass and the working tree has only intentional changes:

1. Inspect `git status` in the terminal.
2. If there are stray or debug edits that should not ship, ask me for confirmation.
3. Otherwise:

   - Run `git add -A`.
   - Generate a concise, conventional commit message summarizing the changes.
   - Run `git commit -m "<your commit message>"`.

If `git commit` fails because there are no changes, tell me that there is nothing to ship and stop.

# Step 3 – Push to origin/main

1. Run `git push origin main`.
2. Show me the result and the CI link (GitHub Actions / whichever CI is configured) from the terminal output if available.

If `git push` fails (e.g. branch is behind):

- Pull with rebase (`git pull --rebase origin main`).
- Resolve any conflicts by editing files.
- Re-run tests if you had to touch logic.
- Re-run `git commit` if necessary.
- Try `git push origin main` again.

When everything is done, summarize:

- What changed.
- Which commands passed.
- The branch and remote you pushed to.
```

Now in Cascade you just type:

```text
/ship
```

Cascade will:

- Use the **terminal tool** to run those commands.
- Fix code until lint/tests/migrations pass.
- Commit & push on your behalf (with your confirmation if you want that). citeturn0search1turn0search14  

That’s your “do a ton of work with agents, then fire off one slash command and let them clean it up and ship it” loop.

---

## 4. Wire Drizzle + Neon into that

In your project, define scripts (example `package.json`):

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "lint": "next lint",
    "test": "pnpm vitest" // or whatever you use
  }
}
```

Your `.env.local` (repo root) stays simple:

```env
DATABASE_URL="postgres://neon:npg@localhost:5432/appdb"
```

or if you’re not using Neon Local, the Neon dev/staging URL. The key is:

- **Cascade doesn’t need to touch env** in your fast loop.
- It just runs `db:generate` / `db:migrate` and hits the same dev DB every time.

In CI for `main`:

1. Use `DATABASE_URL` pointing at Neon `staging` branch.
2. Run:

   ```bash
   pnpm db:migrate   # drizzle-kit migrate
   pnpm test
   ```

If CI passes, your staging DB + preview app are up to date.

---

## 5. Prod still gets a safety rail (but no friction while you’re coding)

To avoid “oops nuked prod” while keeping your local loop fast:

- On push to `main`, CI:
  - Migrates `staging` DB.
  - Deploys `preview.jov.ie`.

- Separate pipeline:
  - Either auto-creates a PR from `main` → `production`, or
  - Auto-merges `main` → `production` when CI is green (once you trust things).

For now I’d keep:

- **Fast path:** local → `/ship` → `main` → staging.
- **Single click:** when you’re happy with staging, click “Merge” for the `production` PR.

You’re not context-switching branches locally at all; you’re just occasionally approving “ship to prod”.

---

## 6. Your day-to-day loop in practice

1. Tell Cascade what to build:
   - “Implement X, update schema, add migrations & tests.”

2. Let it iterate on code & schema locally, hitting your dev Neon DB.

3. When you’re ready to checkpoint:

   ```text
   /ship
   ```

4. Cascade:
   - Fixes lint/tests/migrations until green.
   - Commits & pushes to `main`.

5. CI on `main`:
   - Migrates `staging` DB.
   - Deploys to `preview.jov.ie`.

6. When the feature looks good in staging:
   - Merge `main` → `production` (or let your prod pipeline auto-promote).

That’s it. No branch juggling, no manual git ceremony every 30 minutes. Just “work → `/ship` → keep working”.

---

If you want, next step I can sketch:

- A **GitHub Actions YAML** that:
  - On `push` to `main`: runs migrations/tests on Neon `staging`.
  - On `push` to `production`: runs migrations/tests on Neon `prod`.
- Plus a tiny `drizzle.config.ts` tweak to keep migrations pointing at the right DB in CI.
