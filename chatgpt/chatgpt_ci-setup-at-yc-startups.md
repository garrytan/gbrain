---
title: "CI setup at YC startups"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 69497695-54f0-8327-bbe2-c3647e139e97
message_count: 2
tags: [chatgpt, import]
---
# CI setup at YC startups

> Conversation ID: 69497695-54f0-8327-bbe2-c3647e139e97
> Created: 2025-12-22T16:49:26Z
> Updated: 2025-12-22T16:52:04Z
> Messages: 2

---

## User

ci setup at yc startups

---

## Assistant

Mr. White,

Here’s a **fact-based snapshot of common CI setups at entity["organization","Y Combinator","startup accelerator"] startups**—optimized for speed, low ops overhead, and investor diligence.

image_group{"query":["CI/CD pipeline diagram","GitHub Actions workflow","CircleCI pipeline","startup devops CI"]}

## What YC startups typically run

### 1. CI Platform (default choices)
- **entity["company","GitHub","code hosting platform"] Actions** – dominant default  
  *Reason:* zero setup, tight repo integration, cheap/free early.
- **entity["company","CircleCI","ci cd platform"]** – common for heavier test matrices or legacy repos.
- **entity["company","GitLab","devops platform"] CI** – used when GitLab is already the VCS.

### 2. Triggers & workflow
- Every **PR** → lint + unit tests.
- **Main branch merge** → full test suite + build artifact.
- Optional: nightly jobs for slow integration tests.

### 3. Test stack (by language)
- JS/TS: Jest, Vitest, Playwright (smoke only in CI).
- Python: Pytest.
- Backend services: unit tests only early; integration tests added post-PMF.

### 4. Deployment pattern
- CI → deploy on green:
  - **entity["company","Vercel","cloud deployment platform"] / entity["company","Netlify","web hosting platform"]** for frontend.
  - **entity["company","AWS","cloud computing company"]** (ECS/Fargate/Lambda) or GCP for backend.
- Preview deployments per PR are common for customer demos.

### 5. Security & hygiene (lightweight)
- Secrets via GitHub Actions secrets.
- Minimal SAST (Dependabot, npm audit).
- Formatting enforced in CI (Prettier/Black).

### 6. What they *don’t* overbuild early
- No complex multi-stage pipelines.
- No heavy test coverage gates.
- No bespoke self-hosted runners unless required.

## YC meta-pattern
> **Optimize for iteration speed first.** CI exists to prevent obvious breakage, not to be “enterprise-grade.”

If you want, I can **outline a 30-minute “YC-style” CI template** for your stack (language + hosting).


**Topic:** [[chatgpt-clusters/business_startup]]
