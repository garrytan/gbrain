---
title: "Branch cleanup best practices"
type: note
created: 2025-08-27
updated: 2025-08-27
source: chatgpt-export
conversation_id: 68af4d23-1b84-832d-8227-64a546386bd5
message_count: 2
tags: [chatgpt, import, code]
---
# Branch cleanup best practices

> Conversation ID: 68af4d23-1b84-832d-8227-64a546386bd5
> Created: 2025-08-27T18:23:32Z
> Updated: 2025-08-27T18:23:42Z
> Messages: 2

---

## User

Best way to clean up old branches on a repo? Just delete them?

---

## Assistant

Pretty much, yes — but with a bit of care:

**1. Check if branches are merged.**  
Run:
```bash
git branch --merged main
```
This lists branches already merged into `main` (safe to delete). Do the same for `dev` if you have one.

**2. Delete locally.**  
```bash
git branch -d branch-name   # safe delete (won’t delete if unmerged)
git branch -D branch-name   # force delete
```

**3. Delete on remote.**  
```bash
git push origin --delete branch-name
```

**4. Automate cleanup.**  
- Use `git fetch --prune` regularly — removes remote-tracking references to branches that no longer exist.  
- Some teams set branch protection so main/dev can’t be deleted, but everything else gets cleaned up once merged.

**5. Team workflow.**  
If you’re on a shared repo, check open PRs first. You don’t want to kill a branch someone still needs.

👉 Best practice: delete feature branches right after merging the PR. Keeps the repo lean and avoids confusion.  

Want me to give you a script you can run to batch-delete all merged branches locally and on origin in one go?


**Topic:** [[chatgpt-clusters/code_review]]
