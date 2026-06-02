---
title: "GitHub Code Shipping Stats"
type: note
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a010e5e-9974-83e8-84d1-4a6c05d2cb7c
message_count: 2
tags: [chatgpt, import, code]
---
# GitHub Code Shipping Stats

> Conversation ID: 6a010e5e-9974-83e8-84d1-4a6c05d2cb7c
> Created: 2026-05-10T23:01:54Z
> Updated: 2026-05-10T23:02:28Z
> Messages: 2

---

## User

how can i see how many lines of code i shipped this year on github

---

## Assistant

GitHub itself does not give a clean “lines of code added this year” dashboard for a user account. The best options are:

### Fastest: GitHub Insights (per repo)
On any repo you own:

1. Go to the repo.
2. Click **Insights**.
3. Click **Contributors**.

GitHub shows:
- total commits
- additions
- deletions
- per-week activity

You can sum your repos manually.

---

### Better: Use GitHub CLI
Install: urlGitHub CLIhttps://cli.github.com

Then run:

```bash
git log --author="Tim White" \
--since="2026-01-01" \
--pretty=tformat: \
--numstat | \
awk '{ added += $1; deleted += $2; net += $1 - $2 } END { print "added lines:", added, "deleted lines:", deleted, "net:", net }'
```

That gives:
- total lines added
- deleted
- net lines

Per repo.

---

### Across ALL repos automatically
From a directory containing all your repos:

```bash
find . -name ".git" -type d | while read repo; do
  dir=$(dirname "$repo")
  echo "Repo: $dir"
  git -C "$dir" log --author="Tim White" \
    --since="2026-01-01" \
    --pretty=tformat: \
    --numstat | \
  awk '{ added += $1; deleted += $2 } END { print "Added:", added, "Deleted:", deleted }'
done
```

---

### Best visual tool: GitHub Skyline
urlGitHub Skylinehttps://skyline.github.com

Shows:
- commits
- contribution density
- yearly activity visualization

Not LOC-specific, but useful.

---

### Most accurate for AI-heavy workflows
If you use:
- Claude Code
- Codex
- RooFlow
- GStack
- bots

…GitHub LOC becomes misleading because:
- generated code inflates additions
- rebases/squashes distort metrics
- deleted/refactored code may be higher leverage

A better metric stack for Jovie is probably:
- PRs shipped
- production deploys
- issues closed
- tests added
- user-facing features landed
- regression rate
- median time-to-ship
- uptime/perf improvements

You can still track LOC as a vanity metric or throughput proxy. Just don’t optimize for it.
