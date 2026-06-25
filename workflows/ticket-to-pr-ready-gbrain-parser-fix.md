---
type: workflow
title: Ticket-to-PR-ready loop for bounded GBrain parser fixes
source: codex-session
ingested_via: codex-closeout
ingested_at: '2026-06-24T20:40:00.058Z'
source_kind: codex-session
source_uri: /tmp/refactor-gbrain.md
tags:
  - gbrain
  - loop
  - propose-takes
  - workflow
---

# Ticket-to-PR-ready loop for bounded GBrain parser fixes

Use this loop when GBrain has a small dirty-worktree patch or doctor residue with a focused parser/config/runtime surface and no production or cross-repo mutation required.

Prompt:
> Treat the current dirty patch or highest-value bounded warning as a ticket-to-PR-ready loop. Observe fresh git/runtime state, choose one reversible in-scope action, make only that change, verify with the focused test plus a live `gbrain` readback, run autoreview, commit if clean, and record the result in `/tmp/refactor-gbrain.md`. Stop when the worktree is clean, the warning is proven not safely fixable here, or the next move requires cross-repo/protected-branch approval.

Example from 2026-06-24: normalized `propose_takes` extractor labels (`prediction -> bet`, `judgment/opinion -> take`, `intuition -> hunch`) into canonical GBrain take kinds. Proof gates were `bun test test/propose-takes.test.ts`, `dream --phase propose_takes --dry-run --json`, `bun run typecheck`, autoreview, and commit `bc20f32e`.
