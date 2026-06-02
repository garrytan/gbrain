---
title: "Migration safety workflow"
type: essay
created: 2025-12-11
updated: 2025-12-11
source: chatgpt-export
topic: coding-devops
message_count: 18
tags: [chatgpt, knowledge, coding-devops]
---
# Migration safety workflow

> **Source:** ChatGPT conversation
> **Date:** 2025-12-11T22:25:00Z
> **Messages:** 18
> **Topic:** coding-devops

## Question

Explain to me migration safety and stuff. So I basically have three databases on NEON. I have a permanent production database. Then off of that I make a child branch database called main that is also permanent. And then off of that I have a development database off of production that is permanent. It's a child of production. And I'll, you know, flash the development database and whatnot. Whatever. And I'm working. Basically have CI automatically when I push my stuff from local to main. It goes to staging site preview.jov.ie. It's my staging site. And on that site it has the development server. I don't... I don't know. Anyway. And so I will do my work on main. And then... Or I'll do my work on dev. And then I'll open a new branch. We'll commit it. We'll PR. And then we'll merge into main. And then it has to pass some checks in CI. And then if it passes all those, it goes to... It goes to... Opens up a PR. Automatically opens up a PR to production. And before it can get merged into produ

## Answer

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
   - When you merge both, file order / conten

*(Answer truncated — 11458 chars total)*

## Question

How can I... I have NEON HDD installed, and I'm using Windsurf with Cascade for my coding. How can I set the DB, like so for my workflow you're saying use short-lived database branches that match my feature. How can I get NEON to set or get my AI to set that database and a new branch like can you give me like a slash command or something or like is there a hook because it has Cascade hooks. Can we force Cascade to basically like every time I ask it to build something to spin up a new branch, pull, spin up a new DB matching that branch and then set that DB in the environmental variables or like does NEON have a way to handle auto setting the DB because it seems like a pain in the ass to actually copy that every time you want to. Does NEON CLI or NEON MCP have like a way to handle that?

## Answer

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
> CONN_STRING=$(neon connection-string "$BRANCH_NAME" --project-id "$PROJECT_ID

*(Answer truncated — 8483 chars total)*

## Question

DATABASE_URL is our drizzle env var name
The env is in the root .env.local

## Answer

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
  echo "DATABASE_URL=\"$CONN

*(Answer truncated — 7013 chars total)*

## Question

I want a workflow where I can work solo (no other devs on the project) and just do a ton of work with local AI agents. And fire off a simple slash command or have a cascade hook to have the agents fix all errors and commit and push and have it merge to main and I can keep working.

Whats the best way to handle this without losing moment by doing long push pr merge switch to main branch out start work cycles

## Answer

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
- Appl

*(Answer truncated — 7148 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000a49071f5897ad0ed207fad9d', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 524, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 210998, 'width': 970}
How can we clean up the add state for new cards

## Answer

Nice, this is super close already. The “add” state just looks noisy compared to the other cards. Let’s tighten it up.

### What feels off right now

- The add card is a **different shape and style** (dark, full-height, no colored border), so it looks like a modal jammed into the grid.
- “X (Twitter)” + “Ready to add” + “Cancel / Add” = too many focal points.
- The action buttons are floating in the middle instead of being anchored to a predictable spot, so your eye has to hunt.

### Goal

Make “add” feel like **just another card** with a clear primary action, not a special popover.

---

## 1. Keep the card layout identical

Use the same layout as a normal card:

- Left: icon + name + URL
- Right or bottom: status + primary button

So for the add state:

- **Border color** = your green “ready” color  
- **Background** = same as other cards
- **Content**:

  - Title: `X (Twitter)`
  - Subtitle: `https://x.com/it…`
  - Small badge: `Ready to add`
  - Right/bottom: `Add` button, with a subtle “Cancel” as text or icon.

Visually, it becomes:

> [icon] X (Twitter)  
> url  
> [badge: Ready to add]              [Add] [x]

Instead of a black box that looks like a different component.

---

## 2. Simplify the wording & hierarchy

- You already show the brand + URL → don’t repeat that intent in big text.
- Make **“Add” the only strong CTA**:

  - “Add” = solid button (brand color / green).
  - “Cancel” = text button or small “x” icon top-right of the card.

- “Ready to add” → small, low-contrast badge:

  - e.g. pill in top-left corner or under the name
  - Once added, this badge can change to “Connected” with a check.

---

## 3. Use the same state system for *all* cards

Define states and reuse them:

- **Default (not added)**: neutral border, secondary button `Connect`.
- **Add / pending**: green border, badge `Ready to add`, button `Add`.
- **Connected**: green border, badge `Connected`, small “⋯” menu for remove.
- **Error**: red border, badge `Error`, link `Fix`.

That lets you:

- Drive all visuals with a `status` prop instead of a special “add” component.
- Keep the grid perfectly consistent; only border color, badge text, and button label change.

---

## 4. If you want a *minimal* change right now

Without rewriting the component, you could:

1. **Match the card shell**:
   - Same border radius, same background as TikTok / Spotify.
2. **Move buttons to the bottom-right** of the card, inline:
   - `Ready to add` → small pill under the title.
   - `Add` → single primary button bottom-right.
   - `Cancel` → tiny “x” icon in the top-right corner of the card.

That alone will make the “add” card feel like part of the grid instead of a weird overlay.

---

If you paste the JSX for your card component, I can rewrite it into a single `<ProfileLinkCard status="pending|connected|error">` with the exact layout for the three states, so you can just drop it in.

## Question

I actually wanna tighten ups all cards. I feel like the can just be an icon left and name and user name right vertically stacked and then a vertical ellipsis to the right of that for menu

## Answer

Nice, that mental picture is exactly what you want here, Mr. White: **all cards the same tight row layout** with only status/badge changing.

Let’s lock in a single pattern and let “add” just be one more state.

---

## 1. Layout: one simple row

Structure every card as:

- **Left:** square icon
- **Middle (flex-1):**
  - Line 1: name + optional status pill
  - Line 2: username/URL (muted, truncated)
- **Right:** vertical ellipsis (`⋮`) for menu

Visually:

```text
[icon]  Tim White on TikTok        [⋮]
        @itstimwhite  / tiktok...
```

Same for “add” cards, “connected”, “error”, etc.

---

## 2. Single component with a `status` prop

Example in React + Tailwind (adjust classes to your stack):

```tsx
type LinkStatus = "connected" | "ready" | "new" | "error";

interface ProfileLinkCardProps {
  icon: React.ReactNode;
  name: string;        // "Tim White on TikTok"
  handle: string;      // "@itstimwhite" or url
  status: LinkStatus;
  onMenuClick?: () => void;
}

const statusStyles: Record<LinkStatus, string> = {
  connected: "border-emerald-500/60",
  ready: "border-emerald-500/60",
  new: "border-zinc-700",
  error: "border-red-500/70",
};

const statusLabel: Partial<Record<LinkStatus, string>> = {
  connected: "Connected",
  ready: "Ready to add",
  error: "Error",
};

export function ProfileLinkCard({
  icon,
  name,
  handle,
  status,
  onMenuClick,
}: ProfileLinkCardProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border bg-zinc-900/70 px-3 py-2 ${statusStyles[status]}`}
    >
      <div className="h-8 w-8 shrink-0 rounded-lg bg-zinc-800 flex items-center justify-center">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-50">
            {name}
          </p>

          {statusLabel[status] && (
            <span className="whitespace-nowrap rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
              {statusLabel[status]!}
            </span>
          )}
        </div>

        <p className="truncate text-xs text-zinc-400">{handle}</p>
      </div>

      <button
        type="button"
        onClick={onMenuClick}
        className="ml-2 rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        ⋮
      </button>
    </div>
  );
}
```

Key points:

- **Same shell for every card**, no special “big add” UI.
- The **border color + badge** are the only hints of state.
- The menu (`⋮`) is always in the same place, giving you a clean, scannable grid.

---

## 3. “Add” flow using the same card

For something “ready to add” (that black card in your screenshot), just render:

```tsx
<ProfileLinkCard
  icon={<XIcon />}
  name="X (Twitter)"
  handle="https://x.com/itstimwhite"
  status="ready"
  onMenuClick={openAddMenu} // menu could show: Add, Cancel
/>
```

- The **menu** is where “Add / Remove / Edit username” lives.
- No 

*(Answer truncated — 3784 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000d86c71f5a865740fac24cb11', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 679, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 306530, 'width': 1389}
Give me a prompt to get this more compact. We dont need titles I think right? Probably just grab the name or username for each and put in a small pill or card that has the icon to the left of it and the brand colored border but not a giant card. And then we ca have maybe a card for each category that holds said pills. And the cards are in a 3 column grid or something. Open to ideas though

## Answer

Here you go, Mr. White — this is a **clean, compact, opinionated Cascade prompt** you can drop straight into Windsurf to get AI to redesign the layout into **small pills**, grouped by category, with **icons + username**, **brand-colored borders**, and **no bulky cards**.

Use it as `/compact-links-ui` or attach it to a workflow.

---

# ✅ **Prompt for Cascade / your AI agent**

```
Redesign the Links UI to be significantly more compact and uniform.

Goals:
1. Replace the large link “cards” with small, tight pills.
2. Each pill should contain:
   - Brand icon on the left
   - The display name OR username (whichever is shortest / cleanest)
   - A subtle brand-border outline
   - A hover or tap menu trigger (vertical ellipsis) on the right

3. No titles inside pills (e.g., “Tim White on TikTok” is too long). Prefer:
   - "@itstimwhite"
   - Or “TikTok • @itstimwhite”
   - Use truncation if needed.

4. Organize pills inside category containers:
   - SOCIAL
   - MUSIC SERVICE
   - CUSTOM
   Each category container is a compact rounded rectangle or subtle card.
   Inside each container, pills are displayed in a responsive 3-column grid.

5. The “add / ready” state should ALSO be a pill:
   - Same layout as other pills
   - Border color = green for “ready”
   - Inside pill: icon + label + “Ready to add”
   - Menu ellipsis opens options: Add, Cancel.

6. Make ALL states share the same pill component; state differences come from:
   - Border color (connected, ready, error)
   - Optional badge (small text pill)
   - Menu options

7. Keep colors subtle and modern:
   - Background: dark gray (same as existing theme)
   - Border: brand color but at ~40–60% opacity
   - Text: simple, minimal, no giant headings

8. The final UI should look like a set of compact identity tags rather than full cards.

Implement:
- Rewrite the React component(s) into a reusable <LinkPill /> component.
- Build a <CategorySection /> that takes a title + children pills.
- Make layout responsive for desktop (3–4 columns) and mobile (1–2 columns).
- Remove bulky cards entirely.
- Use Tailwind classes consistent with the existing design language.

After implementing, refactor the current screen to use this new layout.
Make sure the “editing a pending add” state also uses a pill, not a big card.

Begin by generating the components, then update the screen layout, then apply styling cleanup.
```

---

# If you want the even-shorter “magic spell” version

```
Convert all link cards into compact pills: icon left, short label/username middle, vertical ellipsis right. Use subtle brand-colored borders, minimal height, no large cards.

Group pills into category containers (“Social”, “Music Service”, “Custom”), each showing pills in a 3-column grid. Keep backgrounds dark and uniform.

Use the SAME pill component for connected, ready-to-add, and error states—only border color + small badge change. “Ready to add” should NOT produce a big card; it’s just a green-bordered pill with a badge and ellips

*(Answer truncated — 3264 chars total)*

## Question

Lay out our migration plan for me. 

## Answer

Alright, Mr. White. Here’s a **clear, production-safe migration plan** tailored to **Drizzle + Neon + solo dev + heavy AI usage**, optimized for speed *without* schema drift.

This is written as something you can actually follow step-by-step, not theory.

---

# Migration Plan (Authoritative)

## Core principles (non-negotiable)

1. **Schema is the source of truth**
   - TypeScript Drizzle schema files define reality.
   - Databases never “lead” the schema.

2. **Migrations are append-only**
   - Once a migration exists on `main`, it is never edited.
   - Fixes always happen via a new migration.

3. **Only migrations change shared databases**
   - No raw SQL against staging or prod.
   - Ever.

4. **One linear migration history**
   - No parallel migration branches.
   - No rebasing migrations after they hit `main`.

If you follow these four rules, migration pain basically disappears.

---

## Environment layout (final)

### Neon branches
- **prod**
  - Real production
  - Only touched by CI on `production` branch

- **staging**
  - Mirrors `main`
  - CI migrates this on every push to `main`

- **dev**
  - Your local playground
  - Can be reset at will

### Git branches
- **main**
  - Your daily working branch
  - You commit directly to this (solo dev advantage)

- **production**
  - Protected
  - Only receives fast-forward merges from `main`

---

## Drizzle setup (lock this in)

### You only ever run these commands:

- **Generate migrations**
  ```
  drizzle-kit generate
  ```

- **Apply migrations**
  ```
  drizzle-kit migrate
  ```

### You never run:
- `drizzle-kit push` on staging or prod
- ad-hoc `ALTER TABLE` in psql

---

## Daily development flow (this is the fast loop)

### 1. You work locally (with AI)

- AI edits:
  - application code
  - Drizzle schema files
- AI does **not**:
  - edit existing migration files
  - run raw SQL on shared DBs

### 2. When schema changes are needed

You (or AI) do:

```
drizzle-kit generate
drizzle-kit migrate
```

This:
- creates new migration files
- applies them to your **dev** Neon branch
- keeps `_drizzle_migrations` in sync

### 3. You keep working

- No PRs
- No branch switching
- No DB resets unless you want them

---

## Shipping flow (the `/ship` moment)

When you’re ready to checkpoint work:

### Local
1. Run (manually or via Cascade workflow):
   ```
   pnpm lint
   pnpm test
   drizzle-kit generate
   drizzle-kit migrate
   ```
2. Ensure:
   - no migration diffs pending
   - tests pass

3. Commit:
   ```
   git add -A
   git commit -m "feat: <clear description>"
   git push origin main
   ```

### CI on `main`
1. Connects to **Neon staging**
2. Runs:
   ```
   drizzle-kit migrate
   pnpm test
   ```
3. Deploys to preview

If this passes, your schema is now **canonically valid**.

---

## Promotion to production (low-stress)

### Option A (recommended now)
- CI opens PR from `main` → `production`
- You click **Merge**
- CI runs migrations on **Neon prod**
- Deploy happens

### Option B (late

*(Answer truncated — 4770 chars total)*

## Question

Give me this as a prompt I can give to an ai agent to have it implement these rules in our repo and in windsurf an have it adjust our ci accordingly.

## Answer

Here’s a **copy-paste prompt** you can give to a repo-level AI agent (Cascade / Windsurf) to **implement the migration rules**, **add repo guardrails**, and **update CI**. It’s written to be action-oriented and to minimize back-and-forth.

---

## Prompt: “Implement migration rules + CI + Windsurf workflows”

```
You are an autonomous repo agent. Your job is to implement a safe, fast migration workflow for a solo developer using Drizzle + Neon + Windsurf/Cascade.

Hard requirements (do not violate):
- DATABASE_URL is read from repo-root .env.local for local development.
- Treat Drizzle TypeScript schema as the source of truth.
- Migrations are append-only once on main: never modify existing migration files after they exist on main.
- No raw SQL against shared environments (staging/prod) outside of migrations.
- CI must run drizzle-kit migrate (NOT drizzle-kit push) on shared DBs.

High-level plan:
1) Audit current repo structure and tooling.
2) Add guardrails in the repo to prevent migration drift.
3) Add Windsurf workflows and/or hooks to streamline the “ship” flow.
4) Update CI to enforce the rules on main and production, and to run migrations safely.

Step-by-step tasks:

A) Repo audit (read-only first)
- Locate:
  - drizzle config file (drizzle.config.ts/js)
  - Drizzle schema files (e.g. src/db/schema.ts)
  - migrations directory (usually drizzle/ or drizzle/migrations)
  - package manager (pnpm/npm/yarn) and existing scripts
  - CI config (GitHub Actions / etc)
  - any existing db scripts that run drizzle-kit push or raw SQL
- Summarize what you found and what you will change before applying changes.

B) Standardize DB scripts (package.json)
Add/ensure these scripts exist:
- "db:generate" -> drizzle-kit generate
- "db:migrate"  -> drizzle-kit migrate
- "db:check"    -> drizzle-kit check (if available in this repo/tooling)
- "lint" / "test" unchanged but used in workflows and CI

Important:
- Do NOT include drizzle-kit push in any script used for staging/prod.
- If drizzle-kit push exists today, keep it only as an explicit local/dev-only command (e.g. db:push:dev) and add comments warning not to use it in CI.

C) Guardrail: Prevent editing old migrations
Implement ONE of these:
1) A git pre-commit hook (preferred) that fails if any existing migration file is modified instead of only adding new ones.
   - Use a simple approach: detect changed files under the migrations directory; if any are modified (not newly added), block commit.
   - Allow modifications ONLY on branches other than main AND only if the file is not present on origin/main (i.e., hasn’t landed on main yet).
   - Implementation options: husky, lefthook, or a simple scripts/precommit.sh + instructions.

2) If the repo already uses a hooks framework, integrate into it.

D) Guardrail: Drift detection in CI
CI must fail if:
- migrations are inconsistent (collision/out-of-order)
- migrations were not applied cleanly
- schema changes exist without a migration (optional: enforce gener

*(Answer truncated — 5664 chars total)*
