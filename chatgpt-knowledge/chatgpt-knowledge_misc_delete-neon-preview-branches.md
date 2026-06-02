---
title: "Delete Neon preview branches"
type: guide
created: 2025-08-28
updated: 2025-08-28
source: chatgpt-export
topic: misc
message_count: 6
tags: [chatgpt, knowledge, misc]
---
# Delete Neon preview branches

> **Source:** ChatGPT conversation
> **Date:** 2025-08-28T04:52:39Z
> **Messages:** 6
> **Topic:** misc

## Question

Neon constantly exceeds branch limits. But old branches that are deleted dont get deleted from the neon db. How can we make them delete

## Answer

Mr. White—here’s the clean, automated way to reap branches in Neon whenever the matching Git/Vercel preview branch is gone.

# Goal
Delete Neon preview branches (and their compute endpoints) when the corresponding Git branch is deleted or a PR is closed, plus a periodic sweep for stragglers.

# What to set up

**Secrets (in GitHub repo settings):**
- `NEON_API_KEY`
- `NEON_PROJECT_ID`
- (Optional) `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` if you want to cross-check active preview deployments
- `GITHUB_TOKEN` is provided automatically in Actions

**Naming convention:**
Create Neon branches with the sanitized git ref as the Neon `branch.name` (e.g., `feat-add-payments`), so we can look them up by name.

---

## 1) Delete on branch deletion / PR close

`.github/workflows/neon-branch-cleanup.yml`
```yaml
name: Neon cleanup on branch delete/PR close

on:
  delete:            # fires when a branch is deleted
  pull_request:
    types: [closed]  # fires when PR is closed (merged or not)

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
    steps:
      - name: Derive target ref name
        id: ref
        run: |
          # From `delete` event:
          if [ "${{ github.event_name }}" = "delete" ]; then
            REF_NAME="${{ github.event.ref }}"
          else
            # From PR close: use the PR head ref
            REF_NAME="${{ github.event.pull_request.head.ref }}"
          fi
          # sanitize to match your Neon naming scheme if needed
          SAFE_NAME="$(echo "$REF_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-_')"
          echo "safe_name=$SAFE_NAME" >> $GITHUB_OUTPUT
          echo "Deleting Neon resources for: $SAFE_NAME"

      - name: Find Neon branch by name
        id: find_branch
        run: |
          set -e
          BRANCH_JSON=$(curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
            "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches?name=${{ steps.ref.outputs.safe_name }}")
          echo "$BRANCH_JSON" > branch.json
          # jq may return empty; guard for that
          BRANCH_ID=$(jq -r '.branches[0].id // empty' branch.json)
          echo "branch_id=$BRANCH_ID" >> $GITHUB_OUTPUT

      - name: Delete compute endpoints attached to branch (if any)
        if: steps.find_branch.outputs.branch_id != ''
        run: |
          set -e
          # List endpoints and filter by branch_id
          ENDPOINTS=$(curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
            "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/endpoints")
          echo "$ENDPOINTS" > endpoints.json
          ENDPOINT_IDS=$(jq -r '.endpoints[] | select(.branch_id == "'${{ steps.find_branch.outputs.branch_id }}'") | .id' endpoints.json)
          for EID in $ENDPOINT_IDS; do
            echo "Deleting endpoint $EID"
            curl -sS -X DELETE -H "Authorization

*(Answer truncated — 8208 chars total)*

## Question

Does neon not just have a setting to do this?

## Answer

Mr. White—yes, Neon **does** offer a built-in way to automatically delete branches, but there are nuances to how it works. Here’s the breakdown:

---

##  Built-in Branch Expiration (Auto-deletion)

Neon allows you to **set an expiration date/time** when creating a branch—through the Console, API, or CLI. Once that timestamp arrives, Neon automatically deletes the branch and its associated resources. This is ideal for short-lived CI/test environments or PR previews.citeturn0search0turn0search1

###  How it works:
- When creating a branch, toggle **“Expire branch on”** and specify the date and time.
- After that time, Neon cleans up the branch automatically—no scripts needed.citeturn0search0turn0search1
- It’s accessible via:
  - **Neon Console**: UI for manual branch creation/expiration
  - **API and CLI**: For automated workflows

---

##  Caveats & What It Doesn’t Solve

This expiration setting is **static**: it doesn’t automatically adjust or link to external systems like Git or Vercel. In other words:

- If a Git branch is deleted—or a PR is closed—**Neon doesn't automatically expire the branch unless you assigned an expiration when creating it**.
- Neon’s native Vercel integration **creates** branches for preview environments but **does not delete** them when the preview ends automatically.citeturn0search4

---

##  Recommended Strategy

To automate deletion effectively:

1. **Set expiration when the branch is created.**  
   For preview/CI branches, set something like “expire in 1 day” or “expire at PR close time + buffer.”

2. **Use custom cleanup workflows** to delete branches that slip through:
   - Use GitHub Actions on PR close or branch delete events to call Neon’s API and delete the branch.
   - Or run a scheduled sweep to remove orphaned Neon branches (especially useful for estranged stale branches).

This two-pronged strategy—expiration + cleanup automation—ensures branches don't linger indefinitely.

---

## Summary (Concise)

| Question                             | Neon’s built-in support? |
|--------------------------------------|---------------------------|
| Auto-delete branch at certain time   |  Yes—via branch expiration settings. |
| Delete branch automatically on PR close or Git branch delete |  No—requires custom automation (e.g., GitHub Actions). |

So yes, Neon **does support automatic deletion via expiration**, but if you need it to mirror your branch lifecycle, you’ll need an additional cleanup process to fill the gaps.

Let me know if you'd like help wiring that up with GitHub Actions or customizing expiration rules.

## Question

But neon is auto creating the branches with the GitHub intergration

## Answer

Yes—if you’re using Neon’s **managed integrations**, there’s a built-in toggle.

- **Neon ↔ Vercel (managed) integration:** during setup, enable **“Automatically delete obsolete Neon branches”**. Neon will remove the preview DB branch when the matching git branch is deleted. If you don’t see this, you’re likely on the older “Connectable Account” path—switch to the **Neon-managed integration** to get the auto-cleanup option. citeturn0search2turn0search6

- **Neon ↔ GitHub integration:** Neon also ships official GitHub Actions that create **and delete** branches; use the provided **Delete branch** action on PR close/branch delete if you want repo-side control. citeturn0search3turn0search0turn0search8

- Optional safety net: set a branch **expiration** (`expires_at`) so stragglers self-destruct after N hours/days. citeturn0search1turn0search13

If you tell me which integration path you used (managed vs connectable), I’ll give you the exact clicks (or the YAML) to turn this on.
