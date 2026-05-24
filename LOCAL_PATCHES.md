# Local Patches — Triage

Living document. Every patch carried on top of `upstream/master` belongs here, with
a triage decision: **carry on our master**, **move to extension point**, or **delete**.

`anoopkansupada/gbrain` is our canonical repo. `upstream` (garrytan/gbrain) is
read-only — we pull, never push. The default action for any local patch is to
carry it on our master indefinitely; upstreaming is opt-in only when Anoop says so.

Audit cadence: every upgrade. Re-evaluate whether each patch is still load-bearing.

Last audit: 2026-05-23 (post-v0.40.6 upgrade)

---

## Patches that touch `src/` (conflict-prone — minimize these)

### 1. `dc76d3c7` — `--unsafe-bypass-lock` flag on `gbrain dream`
- **Files:** `src/commands/dream.ts` (+7), `src/core/cycle.ts` (+9)
- **What it does:** CLI flag that skips the cycle advisory-lock gate, so manual `gbrain dream --phase X` can run while the autopilot daemon holds the lock. Loud stderr warning. Cron MUST NOT use.
- **Why it exists:** PC2 manual backfill via `~/.gbrain/backfill-synthesize.sh` blocked by `cycle_already_running`.
- **Triage: CARRY.** Operationally needed for manual backfill against a continuously-running autopilot. Pattern matches upstream's existing `--unsafe-bypass-dream-guard`.
- **Maintenance:** verify the lock-gate hook hasn't moved on each upgrade. Currently at `src/core/cycle.ts:1140` (`needsLock` calculation).

### 2. `ea7e039f` — Bootstrap forward-reference for v51/v60/v61 columns
- **Files:** `src/commands/migrations/v0_32_2.ts` (3 lines)
- **What it does:** `notability` column was removed from `facts` in a later wave; the v0_32_2 phase B `SELECT` still referenced it. Patches to `NULL::text AS notability` so brains migrating from <v51 don't crash.
- **Why it exists:** schema v49→v66 forward migration on Supabase brains.
- **Triage: CARRY (until next major schema rev makes v0_32_2 unreachable).** Surgical; bears no real maintenance cost.

### 3. `2a7c51c0` — `repair-type-field.ts` + `types-enum.ts`
- **Files:** `src/commands/repair-type-field.ts` (+199), `src/core/types-enum.ts` (+45)
- **Status:** another agent (pc1) is currently mid-flight moving these to `scripts/` per the original triage suggestion. See `pc1/move-repair-type-field-to-scripts` branch.
- **Triage: MOVE TO `scripts/`** (in progress on pc1 branch). After their PR merges, this entry can be deleted.

---

## Patches in extension points (never conflict)

These touch only `skills/`, `recipes/`, `evals/`, `docs/`, `scripts/`. Upstream additions in these dirs are additive too, so they rebase cleanly. No action required.

| SHA | Path(s) | Purpose |
|---|---|---|
| `4e8b1bef` | `scripts/upgrade.sh`, `.gitignore` | Automated upgrade pipeline (2026-05-23) |
| `17ef649d` | `recipes/brief-to-brain.md` | Call-brief ingest recipe |
| `bea89336` | `skills/call-brief-generator/`, `skills/post-call-processor/` | Locked-schema brief skills |
| `c7cea7bc` | `skills/RESOLVER.md` | Resolver registration for above |
| `3c18593d` | same skills | Garry-convention rewrite |
| `1df122d8` | `skills/call-brief-generator/SKILL.md` | gap_feedback loop |
| `4e5244e1` | `skills/post-call-processor/SKILL.md` | Phase 2 speaker disambiguation |
| `db89117c` | `evals/extractors/*.json`, `recipes/*-to-brain.md`, `scripts/brain-compiler.ts`, etc. | Bulk eval + recipe additions |
| `a0976aae` | `docs/architecture/hermes-harness.md`, `evals/recall-quality.jsonl`, `evals/skill-resolution.jsonl` | Phase-2 design + eval suites |
| `8380a432` | `evals/recall-quality.jsonl` | 12 slug fills |

---

## Detached work preserved on the fork

- `orphan-fix/infer-links-arrays` (a31157ce), `orphan-fix/infer-links-phase` (2e8e25b6) — `infer_links` cycle phase that addresses the 24k orphan crisis. Not on master because the cherry-pick conflicted with later upstream phase additions. Rebase one of these branches on current master and open a PR to our master when ready to ship.

---

## Patches dropped during 2026-05-23 upgrade

Carried for months as deferred work but obsoleted by upstream evolution. Documented as lessons:

- `disk_pressure` doctor check w/ backfill-pause at <5Gi free — upstream's `remediation` system supersedes the simple `actions[]` pattern.
- `actions[]` field on `Check` type — upstream has structured `RemediationStep[]` (richer).
- `markdown.ts` quote-strip fix — upstream rewrote frontmatter handling; verify if the YAML re-quote bug recurs.
- The original `--no-recurse-submodules` patch on `git-remote.ts` — upstream now splits global vs subcommand flag positions correctly.
- The original `safety-snapshot-of-uncommitted` commit pattern — useless after rebase.

**Lesson:** the conflict cost of every `src/` patch compounds. Of the 8 unpushed local commits coming into the upgrade, **3 were already obsolete** because upstream solved the same problem differently. Audit before assuming a patch needs to be re-applied.

---

## Rules for future patches

1. **Default to extension points.** Before touching `src/`, ask: can this be a skill (`skills/`), a recipe (`recipes/`), an integration (`~/.gbrain/integrations/`), or a one-shot script (`scripts/`)? Yes 90% of the time.

2. **`src/` patches need a load-bearing justification.** If it's not operationally critical, don't carry it. The conflict tax on the next upgrade is real.

3. **Don't commit scratch.** `*.mjs`, `*.bak`, `analyze_*.ts` debugging files blocked the v0.40 rebase. `.gitignore` catches them now — keep it that way.

4. **No "safety snapshot" commits.** They add nothing and become empty after rebase. If work isn't ready to commit cleanly, branch + stash.

5. **`scripts/upgrade.sh` is the canonical upgrade.** Don't hand-roll. If it breaks, fix the script.

6. **Our fork is canonical.** Push to `origin` (= anoopkansupada/gbrain). `upstream` (garrytan) is read-only — we pull, never push. Don't propose upstream PRs unless Anoop asks.
