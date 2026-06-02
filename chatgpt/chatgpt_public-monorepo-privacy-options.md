---
title: "Public Monorepo Privacy Options"
type: note
created: 2026-03-05
updated: 2026-03-05
source: chatgpt-export
conversation_id: 69aa170a-fa04-8333-b184-4adfb9b769c1
message_count: 4
tags: [chatgpt, import]
---
# Public Monorepo Privacy Options

> Conversation ID: 69aa170a-fa04-8333-b184-4adfb9b769c1
> Created: 2026-03-05T23:51:59Z
> Updated: 2026-03-05T23:53:24Z
> Messages: 4

---

## User

If you have a public monorepo, is it possible to make parts of it not public? Like if I had a big app that was open source or something, but I wanted to have like some ops dashboards or like documentation or something that was only available internally.

---

## Assistant

Yes. Common options:

- **Split into two repos (most common)**
  - Keep the open-source app in a public repo.
  - Put ops dashboards, internal runbooks, private docs, secrets templates, etc. in a private repo.
  - Connect them with:
    - Git submodules, subtree, or a “mirror” workflow (public repo is a filtered export of the private one).

- **Use a “public mirror” of a private monorepo**
  - Make the real monorepo private.
  - Publish a sanitized, auto-updated public mirror that excludes internal paths.
  - Tools/approaches:
    - `git filter-repo` (recommended) / `git filter-branch` (legacy) / custom CI script to export only selected directories.
  - Important: once something is pushed public, removing it later doesn’t fully retract it from history/forks. Treat anything ever pushed public as potentially permanent.

- **GitHub Enterprise / separate hosting**
  - Keep internal parts on a private GitHub Enterprise org (or separate GitHub org) and public code on GitHub.com, with a sync process.

What generally **doesn’t work** on mainstream Git hosting:
- “Make subfolders private inside a public repo.” Public repos are effectively all-or-nothing for repository contents. You can restrict write access, but not read access to specific directories.

Practical guidance:
- Put **anything operational** (dashboards, on-call runbooks, incident docs, vendor configs) in a private repo by default.
- Never store secrets in either repo; use a secrets manager and inject at deploy time.
- If you need a single developer workflow, use a private “source” monorepo + public mirror so internal and external can share structure without exposing internals.

If you tell me what host you’re using (GitHub/GitLab/Bitbucket) and what “internal” content types you mean (Grafana dashboards, Terraform, runbooks, product docs), I can suggest a concrete layout + sync approach.

---

## User

Main thing is that our main repo is public to benefit from free CI minutes.

---

## Assistant

Mr. White, if the repo is public to get free CI minutes, you cannot make “some folders private” inside that same repo on typical Git hosting (GitHub included). Repository visibility applies to the whole repo. citeturn0search14turn0search5

Patterns that work while keeping free CI on the public repo (common on GitHub, where Actions is free for public repos): citeturn0search0

### 1) Split repos: public app + private internal
- Public repo: product code that you want open + CI workflows.
- Private repo: ops dashboards, runbooks, internal docs, incident notes, infra.
- Link them with:
  - a separate internal docs site/wiki, or
  - a build step that pulls private docs at deploy time (never committed to public).

### 2) Private “source” monorepo + public mirror (sanitized export)
- Real monorepo stays private (contains everything).
- CI publishes a public mirror that excludes internal directories.
- Use history-filtering tools (`git filter-repo`) or a dedicated “export” pipeline.
- Key warning: if internal content ever lands in the public repo (even briefly), it can persist in forks/caches, so treat it as effectively leaked. citeturn0search2

### 3) Keep internal content out of Git entirely
- Ops dashboards: store JSON/provisioning in a private repo or in the dashboard system’s own access controls.
- Internal docs: private doc platform (Confluence/Notion/private Git repo) and publish only selected docs publicly.

### Practical recommendation for your goal (free CI minutes)
- Keep the **public** repo as “open-source + CI”.
- Put **internal** material in a **separate private repo** and reference it from internal tooling/deploy pipelines.
- If you need one-tree ergonomics, use the **private source + public mirror** approach.

If you’re on GitHub Actions specifically, confirm: you’re using GitHub-hosted runners (not self-hosted), and want internal docs/dashboards to be accessible only to employees. GitHub’s stated model is that Actions remains free for public repos. citeturn0search15turn0search0
