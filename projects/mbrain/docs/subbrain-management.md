---
title: Sub-Brain Management Design
type: project
tags: [mbrain, sync, subbrain]
---
MBrain should support a non-git brain container with explicitly registered git-backed sub-brains such as personal and office. [Source: User, direct message, 2026-05-07 22:51 KST]

The approved design uses an engine-backed subbrain registry, mandatory slug prefixes, independent sync checkpoints per sub-brain, deterministic prefixed `put_page` write-back, and unchanged legacy single-repo sync behavior. [Source: Codex, local repo design session, 2026-05-07 22:51 KST]

The design spec was committed to `docs/superpowers/specs/2026-05-07-subbrain-management-design.md` in local git commit `af107f2`. [Source: Codex, local git commit af107f2, 2026-05-07 22:51 KST]

---

- **2026-05-07** | User clarified the target structure as a non-git `brain/` container with git-backed sub-brains such as `personal` and `office`, then approved the explicit registry design. [Source: User, direct message, 2026-05-07 22:51 KST]
- **2026-05-07** | Codex wrote and committed the sub-brain management design spec at `docs/superpowers/specs/2026-05-07-subbrain-management-design.md` in commit `af107f2`. [Source: Codex, local git commit af107f2, 2026-05-07 22:51 KST]