# Fork activity & decision log

> **This is the standing jumping-off point for any agent or human resuming work on
> this fork.** Read this file FIRST, then prepend a new dated entry for your session.

---

## ▶ START HERE — current state & next actions

**Read this block first; it's the one-screen snapshot a resuming session needs.**

### Current state (as of 2026-06-25)
- **Corpus import: Phase B COMPLETE — go-live ready.** All 5 `test_corpus` textbooks are imported
  + embedded: **15 pages / 1,795 chunks**, clean `<book>/partNN` slugs, retrieval verified across
  the corpus.
- **PR #4 merged to master** — carries Entries 1–4, this START HERE block, the `CLAUDE.md`
  pointer to it, and the `test_corpus/` gitignore.

### Pending operator actions (run LOCALLY on the Windows box, pre-reboot — full runbooks in Entry 4)
1. **Expansion auth fix** — `gbrain query` logs `[ai.gateway] expansion disabled: invalid
   x-api-key`, so multi-query expansion is off (core vector retrieval still works). Set
   `OLLAMA_API_KEY` so it stops erroring. *(Root cause + exact commands: Entry 4.)*
2. **Transient-dir cleanup** — delete the conversion scratch dirs (~168 MB), **keep** the proven
   re-import safety net. *(Exact keep/delete list: Entry 4.)*

### Immediate next actions for a resuming session
1. Execute the two runbooks above (from Entry 4) and verify each.
2. **Open a NEW branch off `master`** and record the outcomes as **Entry 5** — PR #4's branch is
   closed once merged, so never reuse `fork-activity-log`.

### Working conventions
- **One new branch off `master` per session/entry**; newest entry on top.
- **Open fork PRs with the `--repo` pin** (gh is installed locally per Entry 3):
  `gh pr create --repo TojotheTerror/gbrain --base master --head <branch> --draft`. The pin is
  mandatory — gh otherwise defaults the base to the `garrytan` **upstream**. **Never touch
  upstream.**
- **Docs-only fork changes take no VERSION bump** (no `/ship`, no 5-file version sync).
- **textbook→gbrain pipeline:** docling `--pdf-backend pypdfium2 --no-ocr` (default backend OOMs)
  → strip base64 `![...](data:...)` figures → split to <500 KB parts → `gbrain import`. docling is
  external pre-conversion, NOT on gbrain's import path.
- **Query-expansion requires `OLLAMA_API_KEY`** (see pending action 1).

---

## Purpose & scope

This is a living, append-only record of everything done to the **`TojotheTerror/gbrain`
fork** — the decisions made and *why*, the blockers/conflicts hit and how they were
resolved, and the commits/branches that resulted.

It is **specific to this fork** and **separate from upstream `CHANGELOG.md`**. The
upstream changelog tracks released gbrain features; this log tracks the *fork's* divergence
from upstream and the operational context a future session needs to avoid re-deriving it
from scratch.

**Convention for future sessions:**

1. **Read this file first** — especially the *Standing fork facts* below.
2. **Prepend a new dated entry** at the top of the *Entries* section (newest on top).
3. Each entry should carry: **date**, a one-line **summary**, the **decisions + rationale**,
   any **blockers + resolution**, and the **resulting commits/branches**.
4. If a *Standing fork fact* changes (mission un-pauses, a patch lands upstream, `/ship`
   becomes available), update the quick-reference block in the same commit.

---

## Standing fork facts (quick reference)

Durable, load-bearing facts. Update in place when they change.

- **Remotes:** `origin = TojotheTerror/gbrain` (this fork) · `upstream = garrytan/gbrain`.
- **`b750d3f` is the load-bearing fork patch** — nomic-embed-text asymmetric prefixes for
  local embedding via LM Studio:
  - `search_document:` / `search_query:` **string prefix** applied in `gateway.ts` (the real
    LM Studio mechanism),
  - `input_type:'document'` set in `dims.ts`,
  - plus an ollama expansion touchpoint.
  - **Local fork only — NOT intended for an upstream PR.** Treat it as deliberate,
    forward-compat divergence; do not "fix" it by reverting.
- **Corpus-import mission: Phase B COMPLETE 2026-06-25.** All 5 `test_corpus` textbooks are
  imported + embedded (15 pages / 1,795 chunks; clean `<book>/partNN` slugs). Phase A proved the
  `b750d3f` asymmetric prefix on ingest (`search_document:` import / `search_query:` query);
  Phase B imported the corpus and verified retrieval across all 5 books.
- **Textbook→gbrain ingest pipeline (hard-won — see Entry 3):** (1) `docling convert <pdf>
  --to md --no-ocr --pdf-backend pypdfium2` — the default `docling-parse` backend OOMs
  (`std::bad_alloc`) on large books; pypdfium2 doesn't. (2) **Strip base64 images** — docling
  embeds figures as data-URIs (87–98% of file size!); regex-drop `![...](data:...)`. (3) **Split
  to <500 KB parts** — gbrain page limits are: 5 MB file cap, ~1 MB `tsvector` hard cap, **500 KB
  `content_sanity.bytes_block`** (above it embedding is skipped), 50 KB warn. (4) `gbrain import`.
  docling is external pre-conversion, NOT on gbrain's import path.
- **`gh` is installed (v2.95.0, winget) + authed.** Open fork PRs with `gh pr create --repo
  TojotheTerror/gbrain --base master --head <branch> --draft` — the `--repo` pin is mandatory
  (gh otherwise defaults the base to the `garrytan` **upstream**). gh lives at
  `…\WinGet\Packages\GitHub.cli_…\bin\gh.exe` (PATH needs a fresh shell). `/ship` is still not
  installed (`[[ship-not-installed-locally]]`); docs-only fork changes take no VERSION bump.
- **Runtime executes `node_modules/gbrain/src/cli.ts` via a Bun shim** — the `b750d3f` patch
  is live at runtime (`bin → src/cli.ts`).
- **Open follow-up: query expansion is broken** — `gbrain query` logs `[ai.gateway] expansion
  disabled: invalid x-api-key`, so multi-query expansion doesn't run (core vector retrieval
  still works). **Root cause:** the `ollama` recipe declares `OLLAMA_API_KEY` *optional*
  (`recipes/ollama.ts`); unset, `defaultResolveAuth` sends `Bearer unauthenticated`
  (`gateway.ts` ~287) which LM Studio rejects. **Fix runbook in Entry 4** (set `OLLAMA_API_KEY`).

---

## Entries

### Entry 4 — 2026-06-25 — Reboot-resume mechanism + two pending operator runbooks

**Summary:** Built the reboot-resume mechanism — a `▶ START HERE` block at the top of this file
plus a strengthened `CLAUDE.md` pointer — so a fresh post-reboot session lands on current state +
next actions the moment `CLAUDE.md` loads. Captured the two remaining operational follow-ups
(query-expansion auth; transient-dir cleanup) as **precise PENDING runbooks** for the local
pre-reboot session to execute. Merged PR #4 to `master` so the mechanism is live there.

**Why these are runbooks, not done:** this entry was authored in a **remote Linux container** with
no access to the owner's Windows machine, `~/.gbrain`, or LM Studio — so the two operational steps
(`setx`, deleting `C:\…` dirs) and their `gbrain` verifications cannot be run or verified here.
They are documented exactly so the local session can run them and record the outcomes as Entry 5.

**Operator runbook 1 — expansion auth fix (run locally, PowerShell):**
- *Root cause:* the `ollama` recipe declares `OLLAMA_API_KEY` **optional**
  (`src/core/ai/recipes/ollama.ts:11`). When unset, `defaultResolveAuth` falls back to a
  `Bearer unauthenticated` token (`src/core/ai/gateway.ts:287`), which LM Studio rejects →
  `[ai.gateway] expansion disabled: invalid x-api-key` (`gateway.ts:2211`) → multi-query expansion
  is silently off (core vector retrieval still works).
- *Fix:* `setx OLLAMA_API_KEY ollama` (persists across the reboot) **and**
  `$env:OLLAMA_API_KEY='ollama'` (current shell, to verify now).
- *Verify:* `gbrain query "<any phrase>"` shows **no** `expansion disabled` warn.
- *Bounded:* if `invalid x-api-key` persists (LM Studio wants a real key / deeper cause), do **not**
  rabbit-hole — record it as a known follow-up and move on.

**Operator runbook 2 — transient-dir cleanup (run locally):**
- *Delete* (all outside the repo): `%USERPROFILE%\gbrain-corpus` (~84 MB raw md),
  `%USERPROFILE%\gbrain-corpus-split` (~84 MB failed 4 MB parts), `%USERPROFILE%\gbrain-canary`
  (canary md); also tidy the session scratchpad's large logs.
- *KEEP:* `%USERPROFILE%\gbrain-corpus-final` (~4.5 MB — the proven <500 KB import source /
  re-import safety net) and `test_corpus\` (source PDFs, gitignored).
- *Verify:* dirs gone; `gbrain stats` unchanged (**15 pages / 1,795 chunks** — brain untouched);
  ~168 MB reclaimed.

**Decisions:** operational steps captured as runbooks (not executed) because the session had no
Windows/brain access; PR #4 merged so `master` carries the resume mechanism before reboot; runbook
paths written as `%USERPROFILE%\…` (not the literal username) to keep the checked-in doc free of
identifying detail.

**Resulting changes:** the `▶ START HERE` block + this Entry 4 + the refreshed expansion
standing-fact in this file, the `CLAUDE.md` pointer change, and the regenerated `llms.txt` /
`llms-full.txt`, committed on `fork-activity-log` → **PR #4 merged to `master`** (intra-fork,
never the `garrytan` upstream).

### Entry 3 — 2026-06-25 — Phase B: full corpus imported (+ go-live prep)

**Summary:** Completed four go-live prerequisites, then imported all 5 `test_corpus` textbooks.
Final brain: **15 pages / 1,795 chunks, all embedded**; retrieval verified across the corpus.
Phase B fought several gbrain page-size limits + heavy docling image-bloat before landing.

**Prerequisites (A–D):**
- **A.** `.gitignore test_corpus/` (the ~75 MB local PDFs are not repo content).
- **B.** Installed `gh` (v2.95.0, winget) + authed; wired up draft **PR #4** intra-fork — retires
  the manual-PR friction (gh defaults the base to the upstream; `--repo` pins it to the fork).
- **C.** Saved the canary learnings as **both** a gbrain note (`dev/docling-large-pdf-oom`,
  tagged `dev-note`) and a `~/.claude` memory. (Distinction that worried the owner: the brain
  *page* was textbook content — re-imported in full here; the *learnings* are these findings.)
- **D.** Dropped the dev pages (`sample` + `test`) surgically (soft-delete → excluded from
  retrieval) so go-live is the corpus + the dev note.

**Phase B — convert → strip → split → import (each step a resolved blocker):**
1. **Convert:** `docling … --pdf-backend pypdfium2` converted all 5 full textbooks (~7 min each;
   the default backend OOMs, pypdfium2 doesn't).
2. **Three import limits, hit in sequence** (first attempt landed 0 of 5): gbrain's 5 MB file cap;
   the ~1 MB Postgres `tsvector` hard cap; and the **500 KB `content_sanity.bytes_block`** (above
   it, embedding is silently skipped — "page lands, 0 chunks"). → split to <500 KB.
3. **base64 image bloat:** the markdown was 87–98% docling-embedded base64 figures (Manning:
   37 MB → 0.9 MB after stripping). Regex-stripped `![...](data:...)` — prose/code preserved.
   Real text is only ~4.5 MB across all 5 books.
4. **Canary-one-book discipline** (advisor's call after two failed imports): split + imported
   Foundations alone first (3 pages, 442 chunks, retrieval @0.87) — *then* batched the rest.
   Final split: 14 parts, all <500 KB.
5. **Import:** all 5 → 15 pages / 1,795 chunks; **0 errors / 0 oversize / 0 tsvector fails**.

**Retrieval check:** Platform Engineering + Foundations queries hit their exact book; the 3
closely-related statistics books (two causal + linear models) cross-retrieve among each other —
expected for overlapping topics. Every query returned a relevant chunk @0.89–0.93.

**Decisions:** stripping base64 was a transparent cleanup, not a route-around — prose preserved;
docling simply shouldn't embed figures for a text brain (use `--image-export-mode placeholder`
next time). The canary page was dropped because it would have duplicated Phase B's full import.

**Open follow-up:** `gbrain query` expansion is disabled (`invalid x-api-key`) — degrades
retrieval quality; core vector search works.

**Resulting changes:** operational (corpus now in `~/.gbrain`; runtime already synced); repo
changes = this Entry 3 + the gitignore, on `fork-activity-log` (PR #4).

### Entry 2 — 2026-06-25 — Phase A canary PASS + runtime re-sync

**Summary:** Ran the Phase A canary against a real PDF and **PROVED** the `b750d3f` asymmetric
prefix fires on the ingest path; re-synced the installed runtime to carry the warn fix while
keeping `b750d3f`; verified both. Phase B is now unblocked (separate step).

**1. Stage 1 (read-only gates).** Refreshed `~/.gbrain/*.step1-backup` (clean rollback / Phase-B
restore point) after a no-holder check. **Embed-config precondition (the load-bearing add from
the cloud refinement):** verified the installed brain embeds via `nomic-embed-text` on the
`openai-compatible` (ollama/LM Studio) recipe — the ONLY config under which the `gateway.ts:1372`
gate can fire — and that the endpoint responds (live embed probe → 768-dim vector). Instrumented
the installed `gateway.ts` with a one-line `[prefix-check]` after the `prefixed` assignment.
**DP1:** the canary path (`import`, `query`) is fully local (local nomic embed + local `qwen`
expansion); `chat_model=anthropic:claude-opus-4-7` is used only by `ask`/reports/enrich/briefing
→ no cloud chunk egress. Proceeded.

**2. Blocker — docling OOM.** docling's default `docling-parse` backend crashed with
`std::bad_alloc` on nearly every page of the 10.6 MB / 490-page textbook (~7 GB free of 32 GB →
a single huge allocation, not total exhaustion). **Resolution:** extracted a 25-page subset via
`pypdf` → `sample.pdf`, then `docling convert … --pdf-backend pypdfium2 --no-ocr` succeeded
(165 KB markdown). **Phase B must use `pypdfium2` + page-batching.**

**3. Canary PASS.** `gbrain import` of the converted markdown emitted
`[prefix-check] search_document: …` on the embed path (the proof). `gbrain query "Yule-Simpson
Paradox"` emitted `[prefix-check] search_query: …` AND retrieved the canary page at the top
(score 0.916) — the **full asymmetric pair**, proven end-to-end. **Correction to the cloud's
static read:** it claimed the query path skips the gate (`dims.ts`); empirically the query
embedding DOES route through `embed()` with `inputType='query'` → `search_query:`. Evidence over
static analysis. De-instrumented `gateway.ts` afterward.

**4. Runtime re-sync.** `robocopy <repo>\src node_modules\gbrain\src /MIR` (master `6cf6729e`
carries both `b750d3f` and the warn fix). Smoke-verified: `gateway.ts` still has the prefixes
(b750d3f intact), `import.ts` now has `warnUnsupportedDocs` (warn fix live), `gbrain --version`/
`stats` work, and a raw-PDF `--no-embed` import now **warns** ("⚠ 5 document file(s) … were NOT
imported") instead of silently dropping. Brain unpolluted (still 2 pages: test + canary).

**Decisions:** canary used 1 doc (smallest, 25-page subset) — canary discipline; DP1 ran but
proceeded (local path + public textbooks); runtime re-synced before Phase B per the owner's ask.

**State handed to Phase B (next, separate approval):** brain = test page + canary page; runtime
carries `b750d3f` + warn fix; docling needs `--pdf-backend pypdfium2`. Phase B: restore
`step1-backup` → convert all 5 via pypdfium2 → import.

**Resulting changes:** operational (no repo code change); this log entry on `fork-activity-log`.

### Entry 1 — 2026-06-25

**Summary:** Resumed the corpus-import mission after a crashed session; ran a read-only Phase 0
audit; landed two fork fixes (warn-on-unsupported-docs + a `dims` test-drift reconciliation);
unified, pushed, and verified fork state. Then created this log + its CLAUDE.md/AGENTS.md
pointers.

**1. Mission & Phase 0 audit (read-only — no fork change).**
Goal: resume importing the corpus into the local PGLite brain using `b750d3f`'s nomic
asymmetric prefixes. The audit confirmed the environment was intact: docling `2.104.0`
installed, the patch live at runtime (`bin → src/cli.ts`), `b750d3f` pushed to origin, the
brain clean (1 test page), LM Studio serving both models, and backups present.
**Discoveries:** (a) docling is NOT on gbrain's import path → it must be an *external*
pre-conversion step; (b) `gbrain import` silently dropped PDF/EPUB/DOCX (an enumeration gap that
produced a false canary "Fail").

**2. Cloud ultraplan / ultrathink.**
Planning was offloaded to a cloud session, which produced the warn-fix.
**Blocker:** the cloud sandbox couldn't push (403 egress); the branch never reached the remote.
**Resolution:** the user pasted the exact, verified diffs inline so they could be applied locally.

**3. Change 1 — warn-unsupported-docs fix** (`import.ts` / `sync.ts` / `import-walker.test.ts`).
*Why:* silent enumeration of unsupported types produced a false canary "Fail." *Decision:* keep
the change at the CLI / observability layer only (warn instead of silently dropping) — no import
behavior change. *Verification:* typecheck clean, 4 new tests, stderr/stdout smoke checks.
**Blocker:** `/ship` not installed locally. **Resolution:** committed to a local branch.
Landed as `223b17e`.

**4. Change 2 — dims test-drift fix** (`test/ai/gateway.test.ts`, `recipe-minimax.test.ts`).
CI surfaced 2 failing `dimsProviderOptions` tests during the merge.
*Root cause:* `b750d3f` changed nomic → `input_type:'document'` but did not update the two
upstream tests that asserted the old shape.
*Blast-radius proof:* a with/without-patch diff (365 pass without the patch, 363 with — exactly
those 2 tests), plus a grep showing every `dimsProviderOptions` assertion lives in `test/ai/`
and no test asserts the embed string prefix.
**Decision: reconcile the tests, NOT revert `dims.ts`.** The patch is intentional and
load-bearing for the corpus-import asymmetry; the `gateway.ts` string prefix is the real LM
Studio mechanism; reverting would undo deliberate forward-compat. Production code was left
untouched; the AI test scope ended at 365 pass / 0 fail. Landed as `6a10c26`.

**5. Unify + push + cleanup.**
Cherry-picked both fixes onto `warn-docs-and-test-drift` (the two changes touch disjoint files →
conflict-free, linear history). Verified: typecheck clean; the only failing tests were the 3
pre-existing Windows symlink-EPERM cases (green on Linux/CI). **Pushed to origin.** Deleted the
two now-redundant local branches.

**6. Divergence check.**
`4372d059` / `v0.42.56.0` turned out to be `upstream/garrytan/pglite-incident-2348`, NOT
`origin/master` → false alarm. Confirmed `local master == origin/master == c7727e6`; merge base
clean.

**7. Net fork state.**
The unified `warn-docs-and-test-drift` branch was **merged into `master` via PR #2** (merge
commit `6cf6729e`); `origin/master == 6cf6729e` and the warn + test-drift fixes are now in the
mainline. The corpus import remains paused at Phase A.

**8. Meta.**
This entry, the log file itself, and the `CLAUDE.md` / `AGENTS.md` pointers to it were created
this session on a `fork-activity-log` branch off `master` — so the doc records its own creation.

**Resulting commits/branches:** `223b17e` (warn fix) → `6a10c26` (test-drift fix), unified on
origin branch `warn-docs-and-test-drift`, **merged to `master` via PR #2 (merge `6cf6729e`)**;
this log committed as `148b562c` on `fork-activity-log`, pushed to `origin` for an **intra-fork
draft PR into `TojotheTerror/gbrain:master`** (fork-only — never the `garrytan/gbrain` upstream).
The cloud-handed source patch (`forkactivitylog.patch`) was deleted post-commit.

**Tooling note for future sessions:** `gh` is NOT installed locally and no API token is in the
env, so fork PRs are opened by hand via the intra-fork compare URL
(`https://github.com/TojotheTerror/gbrain/compare/TojotheTerror:master...TojotheTerror:<branch>?expand=1`)
— never let GitHub default the base to the `garrytan/gbrain` upstream.
