---
title: "GitHub PR Tasks Explained"
type: note
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694adb18-a098-832a-a66f-e54fa1b57fac
message_count: 4
tags: [chatgpt, import]
---
# GitHub PR Tasks Explained

> Conversation ID: 694adb18-a098-832a-a66f-e54fa1b57fac
> Created: 2025-12-23T18:10:36Z
> Updated: 2025-12-23T18:13:03Z
> Messages: 4

---

## User

what do the tasks mean?

---

## Assistant

Mr. White,

On that GitHub pull-request page, **“tasks”** are items in a **task list** inside the PR description or linked issues. They’re written as Markdown checkboxes:

- `- [ ]` = incomplete task  
- `- [x]` = completed task

### What they represent
- **Planned work** required to finish the PR (code changes, refactors, tests).
- **Review feedback** turned into actionable items.
- **Release or merge requirements** (docs updated, migrations run, accessibility checks, etc.).

### Why you see counts like “13 of 35 tasks”
- The first number = how many boxes are checked.
- The second number = total tasks listed.
- GitHub automatically tracks this and shows progress on the PR.

### What they are *not*
- They are **not GitHub Issues** unless explicitly linked.
- They are **not CI checks** (those are the green/red status checks below).

### Practical takeaway
- A PR with many unchecked tasks is usually **intentionally a draft**.
- Reviewers often wait to do a full review until tasks are mostly complete.
- Checking tasks auto-updates progress everywhere the PR is referenced.

If you want, I can tell you **where those tasks live in the PR** or **how to auto-generate them from issues or review comments**.

---

## User

sp s tje wprl pm thos pme fpme pr os sto;; om [rphress?

---

## Assistant

Mr. White,

Here’s the **plain-English version**:

Those **tasks** are just a **checklist template** inside the pull request description.

They mean:
- “Did I do this?” → check the box.
- “Does this apply?” → if not, leave it unchecked.
- GitHub counts **all boxes**, checked or not, and shows progress (e.g., *29 of 54*).

In **your PR (#1421)** specifically:
- Many sections (DB changes, breaking changes, mobile testing, docs) **don’t apply**.
- They’re still unchecked, so GitHub counts them as “incomplete.”
- That **does NOT mean work is missing**—it just means the template is generic.

**Key point:**  
The task count is **not a quality signal**. Reviewers care about:
- CI checks
- Review comments
- Whether required items (tests, accessibility, security) are satisfied

If you want, I can show you **how to collapse or trim the template** so task counts stop looking misleading.
