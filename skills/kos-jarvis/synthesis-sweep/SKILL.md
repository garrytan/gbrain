---
name: synthesis-sweep
version: 1.0.0
description: |
  The "Wisdom layer" sibling of enrich-sweep. Walks each significant entity,
  gathers EVERY source page that mentions it via the by-mention link graph,
  feeds the whole cluster into Opus 4.8 in one large-context shot, and writes
  back a deep, evidence-cited high-level dossier (kind: synthesis). Turns thin
  entity stubs into synthesized knowledge: role, relationships, decision
  timeline, open questions, and cross-source insights a single page can't show.
triggers:
  - "synthesis sweep"
  - "high-level abstraction"
  - "entity dossier"
tools:
  - list_pages
  - get_page
  - put_page
  - query
mutating: true
---

# synthesis-sweep

> **Convention:** see [conventions/brain-first.md](../../conventions/brain-first.md) — this sweep operates entirely on the brain (the `links` graph + `compiled_truth`); no external augmentation.

The DIKW top layer for the fork. enrich-sweep produced entity stubs (Info);
`gbrain extract links/timeline` built the graph (Knowledge); this sweep produces
the synthesis/Wisdom layer with Opus.

## Why this exists (vs gbrain's native dream phases)

gbrain's native `extract_atoms → synthesize_concepts` / `propose_takes` /
`patterns` phases are **schema-pack gated** (only `gbrain-creator` /
`gbrain-everything` declare them) and shaped for **transcript/meeting/article**
page types. The fork's corpus is `email` + entity pages under `gbrain-base`, so
those phases no-op. synthesis-sweep is the fork-local, corpus-shaped path:
direct Opus synthesis over the email/entity graph, no brain-wide pack switch.

## Algorithm

### Phase A — select entities
psql: entity pages (`type` ∈ person/company/concept/project/entity) in the
target source(s), excluding `gbrain-docs`, with ≥ `--min-neighbors`
email/source link-neighbors. Ordered by neighbor count desc.

### Phase B — synthesize (per entity, checkpointed)
1. **Gather** every email/source page linked to the entity (by-mention graph is
   symmetric — the neighbor is whichever link end isn't the entity), recency-desc,
   up to `--token-budget`. Hubs (notion=2161, tp-link=1978 neighbors) exceed any
   window, so the gather **caps and LOGS the drop** (`N/total, drop M`). The
   long tail (<~170 neighbors) is covered in full.
2. **Synthesize** via Opus 4.8 (`gatewayChat`-free; official `@anthropic-ai/sdk`
   through the CRS `/v1` relay, same path as enrich-sweep NER): one large-context
   call → a Chinese markdown dossier (一句话定性 / 关键事实 / 角色与关系 / 决策与
   时间线 / 未决问题 / 可挖掘洞见), each line citing `[来源slug]`. 600s timeout,
   4× backoff retry; fatal auth/quota errors abort the whole run (→ `--resume`).
3. **Write** the dossier back to the entity slug (`gbrain put --source <its source>`)
   → daemon embeds via te3@avman. The dossier upgrades the thin stub in place.

### Phase C — report
synthesized / failed / dropped-source counts + Opus token totals.

## Flags

- `--source <id>` — restrict to one source (default: all non-`gbrain-docs`)
- `--limit N` — first N entities only (small-batch verify)
- `--min-neighbors N` — only entities with ≥ N email/source neighbors (default 3)
- `--kind K` — restrict to one entity type
- `--char-cap N` — per-source-page char cap fed to the model (default 4000)
- `--token-budget N` — total gathered-context token budget per entity
  (default 450000; `SYNTH_CONTEXT_1M=1` → 900000 + 1M beta header)
- `--plan` / `--dry` — select + preview targets (gather sizes), no LLM, no writes
- `--resume` — skip entities already in the checkpoint

## Token budget & CJK (measured 2026-06-02)

The corpus is Chinese-dense: **~1.5 chars/token** (not English's ~4). The budget
is expressed in tokens and converted at 1.5. Measured: a 170-source hub gather
(~675k chars) = **~427k input tokens** — already far past Opus's 200k native
window, and it **works on CRS without a beta header**. The default 450k-token
budget therefore delivers genuinely large-context synthesis; `SYNTH_CONTEXT_1M`
is only needed to push mega-hubs further (and stays under 1M).

## Rate-limit tuning (CRS account, measured 2026-06-02 full run)

The CRS relay account has a tight **input-tokens-per-minute** ceiling. Big-context
requests blow through it fast, so the full run was tuned for stability:

- **`--token-budget 120000 --concurrency 3`** is the stable operating point.
  Measured: `450k budget / conc 4–6` storms `rate_limit_error` (and CF `524`
  timeouts on the slow 450k-token prefills) — backoff absorbs it but throughput
  craters and retries escalate. `120k / conc 3` holds ~**192 dossiers/hr** with
  full-quality output (the 96k-token echo-liu POC proved ~100k context already
  yields an excellent dossier — bigger mostly adds breadth, not depth).
- **Don't rapid kill/restart**: each restart leaves in-flight requests + SDK
  retries that saturate the *rolling* rate-limit window, so the next process
  looks rate-limited even at low concurrency. Change config once, then let the
  backoff pace it.
- **Output is streamed** (`messages.stream().finalMessage()`) with `max_tokens`
  = `SYNTH_MAX_TOKENS` (default 64000) so dossiers are never truncated; >~21k
  non-streamed would be rejected by the API.
- **Backoff** (`synthesize()` + SDK `maxRetries: 8`): 429/503/524/529 → long
  backoff 30s→60s→…→300s honoring `Retry-After`; other transient → linear. A
  near-empty (<400-char) body after a degraded retry is treated as a failure
  (not checkpointed) so garbage is never written.

## Resumability & real-time writes

- **Checkpoint** `~/.cache/kos-jarvis/synthesis-sweep/<scope>.jsonl` — one line
  per synthesized entity. A killed/crashed run resumes (already-done entities
  skipped) — completed dossiers are never re-paid. Loaded automatically when the
  checkpoint exists (explicit `--resume` not required).
- **Real-time**: one `gbrain put` per entity commits + embeds immediately, so
  queries see dossiers accumulate live. Run the full sweep under **nohup**.
- **Lock** `~/.cache/kos-jarvis/synthesis-sweep.lock` prevents concurrent runs.

## Scale (2026-06-02 brain)

| `--min-neighbors` | entities |
|---|---|
| 3 | 1886 |
| 5 | 1517 |
| 8 | 1252 |
| 15 | 907 |

Long-tail entities (3–14 neighbors) are small/fast/cheap calls; the cost is
dominated by the few hundred high-neighbor hubs. Full run is overnight-scale.

## Delegates / related

- `skills/kos-jarvis/enrich-sweep/SKILL.md` — built the entity stubs this sweep
  deepens; shares the checkpoint/fail-fast/nohup patterns.
- `gbrain extract links --by-mention --source db` — builds the link graph this
  sweep traverses (run it before synthesis-sweep).
- `skills/kos-jarvis/type-mapping.md` — `kind: synthesis` filing.

## Rollback

Each synthesized entity is in the checkpoint JSONL. The dossier overwrote the
prior stub (same slug); restore from a pre-run `pg_dump` if a batch needs
reverting, or re-run enrich-sweep to regenerate stubs.
