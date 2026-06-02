---
title: "Update PR branches"
type: note
created: 2025-12-29
updated: 2025-12-29
source: chatgpt-export
conversation_id: 6952b1a9-7018-832e-80dd-24d1fbd11b17
message_count: 2
tags: [chatgpt, import, code]
---
# Update PR branches

> Conversation ID: 6952b1a9-7018-832e-80dd-24d1fbd11b17
> Created: 2025-12-29T16:51:57Z
> Updated: 2025-12-29T16:52:21Z
> Messages: 2

---

## User

update branch on all open prs

---

## Assistant

Mr. White — you can’t truly do this “in bulk” from the GitHub UI. You either click **Update branch** per PR, or you automate it via the GitHub API/`gh`.

### Option A (manual, UI)
Open each PR and click **Update branch** (only shows up when the PR is behind the base branch and branch updates are allowed).

### Option B (bulk, recommended): `gh` script
This updates the head branch of **every open PR** that’s behind (or all open PRs if you remove the filter).

```bash
# prereqs: GitHub CLI + jq
#   brew install gh jq
#   gh auth login

OWNER="JovieInc"
REPO="Jovie"

# Get open PR numbers that are behind base
prs=$(gh pr list -R "$OWNER/$REPO" --state open --json number,isBehind \
  | jq -r '.[] | select(.isBehind==true) | .number')

for pr in $prs; do
  echo "Updating PR #$pr"
  gh api -X PUT "repos/$OWNER/$REPO/pulls/$pr/update-branch" \
    -f expected_head_sha="" >/dev/null \
  || echo "  (failed) #$pr"
done
```

Notes:
- You need **write** permission to the repo/PR branches.
- Some PRs can’t be updated (e.g., merge conflicts, branch protections, “Require linear history”, or head branch is deleted). Those will fail and print `(failed)`.

If you want, tell me whether you want **only PRs behind base** (current script) or **every open PR regardless**, and whether you want it to **skip Dependabot** PRs.
