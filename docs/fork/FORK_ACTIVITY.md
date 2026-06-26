# Fork activity & decision log

> **This is the standing jumping-off point for any agent or human resuming work on
> this fork.** Read this file FIRST, then prepend a new dated entry for your session.

---

## ▶ START HERE — current state & next actions

**Read this block first; it's the one-screen snapshot a resuming session needs.**

### Current state (as of 2026-06-25, Entry 7)
- **Forward follow-ups worked (Entry 7).** Local repo synced to the cleaned master (Entries 1–6);
  **schema-pack v2 migration DONE** (data now `gbrain-base-v2`, config/data drift resolved, 0 pages
  retyped, `pack_upgrade` nudge cleared); **expansion root cause FOUND + Layer-1 fixed** (see below).
  The `resolver_health` "green the full doctor" item was **deferred** (the cloud's "repo is clean"
  premise was disproven locally — the repo tree fails it too; `--scope=brain` exit 0 is the real
  signal). Brain untouched at 15 / 1,795 / 1,795 throughout.
- **GO-LIVE ACCEPTED (Entry 6 — Phase C).** Full health validation passed:
  `gbrain doctor --scope=brain` = **exit 0, 65/100, all checks OK**; the **agent-facing MCP path
  proven end-to-end** (`gbrain serve` stdio → `query` op returns corpus chunks, 15 pages /
  1,795 chunks via the real MCP SDK); retrieval verified across **all 5 books** (each distinctive
  query hits its own book @0.91–0.93); the load-bearing `b750d3f` asymmetric prefix confirmed live
  in the runtime.
- **Doctor full-run reads 35/100 / exit 1 — EXPECTED, not a regression.** The entire gap from the
  65/100 brain-scope is the `skills/` routing lint (`resolver_health`: 1 err + 67 warn), which is
  brain-independent and excluded by `--scope=brain`. Brain data is healthy (embed/retrieval 35/35;
  the `brain_score` 45 is corpus-expected — split textbooks have no wikilinks/timeline/entity pages).
- **Corpus import: Phase B COMPLETE.** 15 pages / 1,795 chunks, all embedded; clean `<book>/partNN`
  slugs.
- **Schema pack: RESOLVED (Entry 7).** Data migrated to `gbrain-base-v2`; config == data; no nudge.
- **Expansion: root cause FOUND; Layer-1 fixed, Layer-2 deferred (Entry 7).** The `invalid x-api-key`
  was **Anthropic's** error — expansion was routing to the `anthropic:claude-haiku-4-5` *default*
  (the `utility`-tier resolution outranks the config.json `expansion_model` fallback), hitting
  `api.anthropic.com` with no key. **LM Studio was never involved** (corrects Entry 5's premise).
  **Layer-1 fix:** `gbrain config set models.expansion ollama:qwen3.5-4b` → expansion now routes to
  local qwen. **Layer-2 (deferred):** LM Studio then returns `400 'response_format.type' must be
  'json_schema' or 'text'` — an SDK↔LM-Studio structured-output mismatch. Non-blocking; core
  retrieval unaffected; tracked in `TODOS.md`.
- **PRs:** PR #4 (Entries 1–4), PR #5 (Entry 5), PR #6 (Entry 6) merged to master. PR #7 (Entry 7)
  is the current intra-fork follow-up.

### Pending operator actions
- **None.** Go-live is accepted and the brain is healthy. All open items are non-blocking and
  documented (expansion warning; schema-pack upgrade-available; a separate `skills/` routing-lint
  cleanup filed in `TODOS.md`).

### Immediate next actions for a resuming session
1. Nothing operational is pending — the brain is **go-live accepted**; schema is on v2.
2. Optional non-blocking follow-ups (all in `TODOS.md`): **expansion Layer-2** (SDK↔LM-Studio
   `response_format` mismatch — make the openai-compat `generateObject` send `json_schema`, or use a
   compatible LM Studio build/model); the `skills/` `resolver_health` routing-lint cleanup. None
   affect retrieval. The expansion "set OLLAMA_API_KEY / diff LM Studio request" leads from Entries
   5–6 are **obsolete** (root cause was Anthropic-default routing, now fixed at Layer-1).
3. **Open a NEW branch off `master`** for any new work; newest entry on top.

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
- **Query-expansion root cause (Entry 7):** `invalid x-api-key` was **Anthropic's** auth error —
  expansion routed to the `anthropic:claude-haiku-4-5` default (utility-tier outranks the config
  `expansion_model` fallback), NOT LM Studio. **Layer-1 fixed** via `gbrain config set
  models.expansion ollama:qwen3.5-4b`. **Layer-2 deferred:** LM Studio `400 response_format.type`
  (SDK structured-output mismatch). Core retrieval unaffected. The Entry-5/6 `OLLAMA_API_KEY` and
  "diff the LM Studio request" leads are **obsolete**.

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
- **Go-live ACCEPTED 2026-06-25 (Phase C, Entry 6).** Validated end-to-end: brain-scoped doctor
  exit 0; agent-facing MCP path proven (`gbrain serve` → `query`); 5/5 books retrieve to their own
  book @0.91–0.93. **Read the doctor score correctly:** use `gbrain doctor --scope=brain`
  (**65/100, exit 0**) as the brain-health signal. The full `gbrain doctor` (**35/100, exit 1**) is
  dragged down by `resolver_health` (1 err + 67 warn) — a **`skills/` routing-metadata lint,
  brain-independent** (`skill-optimizer` unreachable + MECE/fixture gaps), believed pre-existing /
  upstream (NOT re-verified against a clean upstream clone). It is NOT a brain regression. **Entry 7
  note:** the cloud's claim that the *repo* `skills/` passes was disproven locally — the repo tree
  fails `resolver_health` too; `--scope=brain` (exit 0) is the trustworthy signal, not a green full doctor. The `brain_score` 45 (links 0/25,
  timeline 0/15, orphans 0/15) is **corpus-expected** — a split-textbook corpus has no
  wikilinks/timeline/entity pages; embed/retrieval is a perfect 35/35. `pgvector` /
  `embedding_width_consistency` "could not check / skipped" are benign **PGLite** introspection
  limits. The `skills/` routing-lint cleanup is filed separately in `TODOS.md` — do NOT fold a
  68-issue shared-`skills/` refactor into a brain entry.
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
- **Query-expansion: ROOT CAUSE FOUND (Entry 7); Layer-1 fixed, Layer-2 deferred.** Multi-query
  expansion was disabled by `[ai.gateway] expansion disabled: [expand] invalid x-api-key`. **The
  message was Anthropic's, not LM Studio's** — instrumenting `expand()`'s catch
  (`gateway.ts:~2207`) showed the call going to `https://api.anthropic.com/v1/messages` with
  `anthropic:claude-haiku-4-5-20251001` and no key → HTTP 401 `authentication_error / invalid
  x-api-key`. **Why that model:** `reconfigureGatewayWithEngine` (`gateway.ts:446`) resolves
  expansion via `resolveModel(configKey:'models.expansion', tier:'utility', fallback:
  cfg.expansion_model)` — the `utility`-tier default **outranks** the `config.json`
  `expansion_model: ollama:qwen3.5-4b`, which is only the lowest-precedence fallback (so neither
  config.json nor `GBRAIN_EXPANSION_MODEL` changed it). **Layer-1 fix (applied):** `gbrain config
  set models.expansion ollama:qwen3.5-4b` → expansion now routes to local qwen. **Layer-2
  (deferred, `TODOS.md`):** LM Studio then returns `400 'response_format.type' must be 'json_schema'
  or 'text'` — the openai-compat `generateObject` sends a `response_format` shape this LM Studio
  build rejects (a hand-issued `json_schema` request returns 200). **Core vector retrieval is
  unaffected.** The Entry-5/6 `OLLAMA_API_KEY` + "diff the LM Studio request" leads are **obsolete**
  (they targeted the wrong service).

---

## Entries

### Entry 7 — 2026-06-25 — Four forward follow-ups (sync · resolver-defer · schema-v2 · expansion root cause)

**Summary:** Executed an ultraplan-refined, leverage-ordered sequence of the four remaining
non-blocking follow-ups locally. **Schema-pack v2 migration DONE; expansion root cause FOUND and
Layer-1 fixed** (a major correction to Entries 5–6); resolver "green doctor" deferred after its
premise was disproven. Brain untouched at 15 / 1,795 / 1,795 throughout. Ordering rationale: easy
enabling work first (sync → trustworthy signal), the one reversible mutation next (schema), the
open-ended debug last (expansion).

**Step 1 — Local sync (foundation).** Synced the stranded local clone (it was on the deleted
`fork-entry-6-golive-acceptance`) to the cleaned remote `master` (Entries 1–6 merged); pruned the
five stale feature branches so only `master` remained. Then branched `fork-entry-7-followups`.

**Step 2 — "Green the full doctor" → DEFERRED (premise disproven).** The ultraplan refinement
claimed the repo `skills/` was already clean and `resolver_health` only failed on a *different*
(bundled/OpenClaw) skills tree. **Disproven locally:** with `GBRAIN_SKILLS_DIR` pointed explicitly
at the repo `skills/`, `gbrain doctor` still FAILs `resolver_health` (1 err + 67 warn; fix paths
resolve to the repo's own `RESOLVER.md`). So greening the full doctor is a real, upstream-shared
`skills/` refactor with zero brain value — and it was never needed: **`gbrain doctor --scope=brain`
= exit 0** is the trustworthy go-live signal (it excludes the SKILL category). Per owner: defer;
resolver stays the `TODOS.md` item.

**Step 3 — Schema-pack v2 migration → DONE.** Backed up `~/.gbrain` (`brain.pglite.pre-v2-*`).
`gbrain onboard --check --explain` → `gbrain jobs submit unify-types --allow-protected --params
'{"target_pack":"gbrain-base-v2"}' --follow` (PGLite runs jobs **inline only** via `--follow`; the
`jobs work` daemon is Postgres-only). The migration flipped the active pack
`gbrain-base@1.0.0 → gbrain-base-v2@1.0.0+b9bebaa4` with **0 pages retyped** (the 2-type corpus
needed no collapsing — it was a clean config/data-drift resolution). Verified: `gbrain schema
active` == v2; brain-scope doctor exit 0 with `pack_upgrade_available` now **OK** (was WARN);
`gbrain stats` unchanged 15 / 1,795 / 1,795; retrieval @0.93 unchanged.

**Step 4 — Expansion bug → ROOT CAUSE FOUND (corrects Entries 5–6).** Instrumented `expand()`'s
catch (transient, reverted after) and found the failure was **never LM Studio**: expansion was
calling `https://api.anthropic.com/v1/messages` with `anthropic:claude-haiku-4-5-20251001` and no
key → 401 `invalid x-api-key` (Anthropic's own header/error). Cause:
`reconfigureGatewayWithEngine` (`gateway.ts:446`) resolves expansion through
`resolveModel(configKey:'models.expansion', tier:'utility', fallback:cfg.expansion_model)` — the
`utility`-tier default **outranks** the `config.json` `expansion_model`, which is only the
fallback (so neither config.json nor `GBRAIN_EXPANSION_MODEL` could change it). **Layer-1 fix
applied:** `gbrain config set models.expansion ollama:qwen3.5-4b` → expansion now routes to local
qwen. That exposed **Layer-2 (deferred):** LM Studio returns `400 'response_format.type' must be
'json_schema' or 'text'` — the openai-compat `generateObject` sends a `response_format` this LM
Studio build rejects (a hand-issued `json_schema` request returns 200). Instrumentation reverted;
runtime verified clean (`b750d3f` prefix intact). Core retrieval unaffected.

**Decisions:** treated the disproven resolver premise as ground-truth-over-static-read (ran the
doctor, didn't trust the claim); skipped the upstream-shared `skills/` refactor (no brain value,
owner-deferred); kept the `models.expansion` config (correct local routing, strictly better than
the accidental Anthropic default, reversible); bounded Step 4 at root-cause + Layer-1 fix +
Layer-2 documentation rather than chasing the SDK/LM-Studio `response_format` mismatch.

**Resulting changes:** operational (schema→v2; `models.expansion` set; `~/.gbrain` backup kept; no
repo code change — instrumentation was runtime-only and reverted); repo changes = this Entry 7 +
the refreshed START HERE + corrected standing facts + the `TODOS.md` expansion-followup rewrite, on
`fork-entry-7-followups` → intra-fork **PR #7** (docs-only, no VERSION bump; never the `garrytan`
upstream).

### Entry 6 — 2026-06-25 — Phase C: go-live health validation & acceptance

**Summary:** Ran the first holistic health validation of the corpus brain (the mission had only ever
proved import + ad-hoc retrieval). Investigated every `gbrain doctor` finding rather than
blanket-accepting the score, proved the **agent-facing MCP path** end-to-end, and confirmed
retrieval across all 5 books. **Result: GO-LIVE ACCEPTED.** Authored locally on the Windows box
(live `~/.gbrain` + LM Studio); the cloud session that refined the plan couldn't run any of it.

**The doctor-score reframe (the headline):** `gbrain doctor` full-run reads **35/100, exit 1**, but
that is **not** the brain failing. `gbrain doctor --scope=brain` reads **65/100, exit 0, all checks
OK**. The entire gap is the SKILL category: `resolver_health` FAILs with 1 error + 67 warnings —
`skill-optimizer` is unreachable (confirmed absent from `skills/RESOLVER.md`) plus MECE
routing-coverage + routing-fixture lints across the skill set. **This is pre-existing `skills/`
routing-metadata hygiene, brain-independent — it would fail identically on a fresh upstream clone.**
Filed as a separate `TODOS.md` follow-up; deliberately NOT folded into this brain entry (it's a
68-issue shared-`skills/` refactor).

**Each remaining finding investigated & classified:**
- **`brain_score` 45/100** (links 0/25, timeline 0/15, orphans 0/15) → **corpus-expected**. Proven:
  `gbrain orphans` = 15/15 (no page has inbound wikilinks), `gbrain check-backlinks` = none missing
  (no links exist to break). Split textbooks legitimately have no wikilinks/timeline/entity pages.
  embed/retrieval is a perfect 35/35.
- **`pgvector` / `embedding_width_consistency` "could not check / skipped"** → benign **PGLite**
  introspection limits (no extension mechanism); the real embedding signal is coverage 35/35 and
  the live 768-d vectors. `jsonb_integrity` "could not check" same class; indirect evidence clean
  (1,795 well-formed embedded chunks, all queries return structured payloads).
- **`content_sanity_audit_recent` 41 events (24 soft-block / 17 warn)** → all `PAGE_OVERSIZE*`
  import-guard events: the 24 soft-blocks are abandoned oversize attempts (pre-split hyphenated
  slugs that never entered the brain), the 17 warns are the accepted 50–500 KB `<book>/partNN`
  parts. **No chunk loss** — `embedded == chunks == 1,795`. The size guard worked as designed.

**Agent-facing MCP path — PROVEN (the real consumer test):** drove the live brain through the exact
agent wiring in `~/.claude.json` (`command: gbrain, args: [serve]`, stdio) via the official MCP SDK
(`StdioClientTransport`). Handshake succeeded; 92 tools exposed incl. `query`/`search`/`get_page`/
`get_brain_identity`; `get_brain_identity` → 15 pages / 1,795 chunks; `query("platform engineering")`
returned 13 KB topped by the correct book. CLI passing ≠ MCP passing — this closes that gap.

**Retrieval acceptance — 5/5 books to their own book** (distinctive query each, scores 0.91–0.93,
in/above the Entry-3 band): Fisher randomization → *a-first-course-in-causal-inference* @0.9218;
double-ML/Neyman → *applied-causal-inference* @0.9259; SVD/high-dim → *foundations-of-data-science*
@0.9062; OLS diagnostics → *linear-models-and-extensions* @0.9295; internal developer platform →
*manning-effective-platform-engineering* @0.9183. The load-bearing `b750d3f` asymmetric prefix is
**live in the runtime** (`node_modules/gbrain/src/core/ai/gateway.ts:1372–1373`, `search_query:` /
`search_document:`), and the 0.91+ asymmetric matching is functional proof it fires — so the
mutating instrument-then-revert re-run was skipped (Entry 2 already proved it directly; code path
unchanged). The expansion warning still fires (Entry 5's deprioritized item) — core retrieval is
unaffected.

**Schema-pack decision (owner's call):** config declares `gbrain-base-v2`, but the data is typed
under `gbrain-base@1.0.0` (the v2 `unify-types` migration was never run). **Zero functional impact**
— retrieval/embedding/MCP all passed regardless, and the corpus uses only 2 page types. The cloud's
"v2 is unresolvable → fell back" hypothesis was **disproven** (`gbrain schema active` resolves v2
from home-config). Per the owner: **document & defer** — mutate nothing; the reversible v2 migration
(72 h soft-delete TTL + `legacy_type` preservation) stays available if ever wanted.

**Decisions:** investigated each failure instead of accepting the headline 35/100 (it would have
mislabeled healthy brain data as broken); used `--scope=brain` as the true go-live signal; proved the
MCP consumer path, not just the CLI; skipped the brain-mutating prefix re-instrument (functional +
unchanged-code-path evidence sufficed); deferred the schema-pack per owner; kept the `skills/`
routing-lint out of this brain entry (separate `TODOS.md` item).

**Resulting changes:** operational acceptance (no brain mutation; `gbrain stats` unchanged at
15/1,795/1,795 throughout); repo changes = this Entry 6 + the refreshed START HERE + the new go-live
standing fact + a `TODOS.md` resolver-lint follow-up, on `fork-entry-6-golive-acceptance` →
intra-fork **PR #6** (docs-only, no VERSION bump; stacks on PR #5; never the `garrytan` upstream).

### Entry 5 — 2026-06-25 — Executed Entry 4's two operator runbooks (local Windows session)

**Summary:** This was the local Windows resume Entry 4's runbooks were written for. Ran both
on the owner's box (`win32`, local `~/.gbrain`, LM Studio serving). **Runbook 2 (cleanup) is
done and clean.** **Runbook 1 (expansion auth fix) was executed and its verification FALSIFIED
the inherited hypothesis** — setting `OLLAMA_API_KEY` does not fix the warning. That falsification
is the real deliverable: it spares every future session the same dead end.

**Runbook 1 — expansion auth fix: hypothesis DISPROVEN.**
- Did: `setx OLLAMA_API_KEY ollama` + `$env:OLLAMA_API_KEY='ollama'` (persisted; confirmed a child
  process inherits the inline value). A fresh **uncached** `gbrain query "…" --expand` *still*
  logs `[ai.gateway] expansion disabled: [expand] invalid x-api-key`.
- Ruled out, with evidence:
  - **LM Studio is not rejecting auth** — a direct `Bearer ollama` chat to `qwen3.5-4b` → 200;
    a `Bearer unauthenticated` chat → **also 200** (it accepts any/no token).
  - **Model + capability present** — `qwen3.5-4b` is loaded; gbrain's *exact* expansion request
    (a `response_format: json_schema` structured call) issued by hand → 200 with valid JSON.
  - **Env propagation works** — an inline `$env:` value is seen by child processes.
  - **Not auth at all** — embedding and expansion resolve auth through the *same*
    `defaultResolveAuth(recipe, cfg.env, …)` (`gateway.ts:316` vs `:1876`); embedding **succeeds in
    the same `gbrain query` process** that the expansion fails in. `invalid x-api-key` is
    `normalizeAIError` passing through an underlying message (`errors.ts:54-66`), not a key gbrain
    can be handed.
- *Bounded per Entry 4:* stopped at the "deeper cause — don't rabbit-hole" line. Recorded as a
  deprioritized follow-up (see the standing fact). **Core vector retrieval is unaffected.**
  The `setx` is harmless (LM Studio ignores the value) — left in place, noted as a no-op.
- **Real next lead (future session, not this one):** capture LM Studio's server-side request log
  for the expansion call and diff it against the working hand-issued probe; suspect the
  openai-compat custom-fetch wrapper (`gateway.ts:2153`).

**Runbook 2 — transient-dir cleanup: DONE.**
- Deleted `~/gbrain-corpus` (84 MB raw md), `~/gbrain-corpus-split` (84 MB failed 4 MB parts),
  `~/gbrain-canary` — **~169 MB reclaimed** (matches Entry 4's ~168 MB estimate).
- **Kept** `~/gbrain-corpus-final` (~4.4 MB proven <500 KB import source / re-import safety net)
  and `test_corpus/` (5 source PDFs, gitignored — `git check-ignore` confirms).
- Verified: the three dirs are gone; `gbrain stats` unchanged at **15 pages / 1,795 chunks /
  1,795 embedded** (brain untouched).

**Decisions:** treated the falsified runbook as a *success of the runbook design* (Entry 4 was
authored blind in a remote container; runbook 1 existed precisely to test "set the key" against
real hardware) and corrected the inherited START HERE + standing fact rather than leaving a
disproven "fix" in the docs; left `setx` in place as a harmless no-op; did not chase the deeper
expansion cause (bounded per Entry 4).

**Resulting changes:** operational (169 MB reclaimed; brain unchanged); repo changes = this Entry 5
+ the refreshed START HERE block + the corrected expansion standing fact, on a new branch
`fork-entry-5-runbooks` off `master` → intra-fork **PR #5** into `TojotheTerror/gbrain:master`
(docs-only — no VERSION bump; never the `garrytan` upstream).

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
