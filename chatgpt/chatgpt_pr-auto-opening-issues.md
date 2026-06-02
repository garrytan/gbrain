---
title: "PR Auto-Opening Issues"
type: note
created: 2026-03-09
updated: 2026-03-09
source: chatgpt-export
conversation_id: 69ae595b-9af0-8330-9ad0-37b194e9d5b0
message_count: 2
tags: [chatgpt, import, code]
---
# PR Auto-Opening Issues

> Conversation ID: 69ae595b-9af0-8330-9ad0-37b194e9d5b0
> Created: 2026-03-09T05:23:52Z
> Updated: 2026-03-09T05:24:03Z
> Messages: 2

---

## User

keep opening prs

---

## Assistant

In the Codex workflow, repeated PR creation usually occurs when the agent continues pushing commits to the same branch while the “auto-open draft PR” rule remains active.

Typical causes:

1. **AGENTS.md rule**
   - If the repo contains a rule similar to:  
     “Codex must auto-open draft PRs after pushing branches.”
   - Every push or branch recreation can trigger a new PR.

2. **Branch recreation**
   - The agent may:
     - create branch → push → open PR  
     - modify branch → push again → system interprets as a new branch state → open another PR.

3. **Multiple tasks targeting the same branch**
   - Separate tasks generating commits for the same issue can trigger additional PRs.

4. **Force pushes or branch resets**
   - If the agent rebases or force-pushes, the integration may open another draft PR.

Mitigations:

- **Require PR reuse**
  Add a rule in `AGENTS.md`:

```
If a PR already exists for a branch:
- update the existing PR
- never open a new PR
```

- **One branch per Linear ticket**
  Enforce naming like:

```
jov-1429-contact-links
```

- **Disable auto-open after first PR**
  Replace rule with:

```
Create a PR only if no PR exists for the branch.
Otherwise push commits to the existing PR.
```

- **Lock PR creation to main branch diff**
  Only open when:

```
branch != main AND no existing PR to main
```

If desired, provide your current **AGENTS.md** contents and I will produce a corrected version that prevents duplicate PR creation.
