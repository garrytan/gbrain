# RFC: `--workers N` for all bulk operations

## Problem

`extract-conversation-facts` processes 6,594 conversation pages serially. At ~2 pages/min, the full backfill takes **~50 hours**. The LLM extraction calls are I/O-bound (waiting on API responses), not CPU-bound — perfect for concurrency. But there's no `--workers` flag.

The workaround today is launching 5 separate processes manually and relying on the terminal audit row as a distributed lock. This works (we confirmed it — 5 parallel processes immediately jumped to ~10 pages/min) but it's brittle:

- **No coordination**: all 5 enumerate the full page list independently. They skip completed pages via the terminal audit row, but two workers can claim the same page before either writes the checkpoint. This wastes LLM calls (duplicate extraction) and can produce duplicate fact rows.
- **No backpressure**: 5 processes × N segments × embedding calls can spike API rate limits with no shared rate limiter or token budget tracker.
- **No progress reporting**: each process logs independently. No unified view of "X of Y pages done, $Z spent."
- **Manual lifecycle**: if one crashes, the operator has to notice and restart it.

## The pattern that works: `gbrain embed`

`embed` already solves this correctly with a **sliding worker pool**:

```
// Sliding worker pool: N workers share a queue and each pulls the
// next key when it finishes. Throughput is much better than a 
// fixed-window Promise.all, since fast workers don't wait for slow 
// workers to finish an entire window.
```

Key design elements from `embed`:
- `--workers N` flag (default 20 for embeddings)
- Shared budget tracker across all workers
- Jittered backoff on rate limits so workers don't resynchronize
- Workers check budget before claiming the next item
- Single progress counter

## Affected commands

Every command that iterates pages and makes API calls per page should support `--workers`:

| Command | Current | API-bound? | Priority |
|---------|---------|-----------|----------|
| `extract-conversation-facts` | Serial | Yes (LLM extraction + embedding) | **P0** — 50hr backfill |
| `dream` | Serial | Yes (LLM) | P1 |
| `extract` | Has `pMap` but hardcoded concurrency | Yes (LLM) | P1 |
| `edges-backfill` | Serial | Yes (LLM) | P2 |
| `reindex` | Serial | Mostly CPU | P3 |
| `reindex-code` | Serial | Mostly CPU | P3 |
| `reindex-frontmatter` | Serial | Mostly CPU | P3 |
| `reindex-multimodal` | Has some parallelism | Yes (embedding) | P2 |

Commands that already handle concurrency well:
- `embed` — sliding worker pool, the gold standard
- `sync` — parallel page processing
- `backfill` — parallel with limits

## Proposal

### 1. Extract the worker pool from `embed` into a shared utility

```typescript
// src/core/worker-pool.ts
export interface WorkerPoolOpts<T> {
  items: AsyncIterable<T> | T[];
  workers: number;
  budget?: BudgetTracker;
  onItem: (item: T, workerIdx: number) => Promise<void>;
  onProgress?: (done: number, total: number, cost: number) => void;
  sleepMs?: number;         // inter-item delay per worker
  jitterFactor?: number;    // ±jitter on backoff (default 0.3)
}

export async function runWorkerPool<T>(opts: WorkerPoolOpts<T>): Promise<WorkerPoolResult>;
```

### 2. Add `--workers N` to every bulk command

Default: 1 (backward compatible). Recommended: 5 for LLM-bound, 20 for embedding-bound.

For `extract-conversation-facts` specifically:
- The page enumeration query already filters out completed pages (those with terminal audit rows)
- Workers claim pages from a shared async iterator — no duplicate processing
- The shared `BudgetTracker` enforces `--max-cost-usd` across all workers
- Progress logs show unified counts: `[extract-conversation-facts] 1,234 / 6,594 pages (18.7%) | $12.34 spent | 5 workers`

### 3. Make `--background` jobs inherit `--workers`

When submitted as a Minion job, the worker count should be passed through:
```bash
gbrain extract-conversation-facts --background --workers 5 --max-cost-usd 9999
```

## Real-world numbers

From our backfill on a 197K-page brain (6,594 conversation pages):

| Workers | Pages/min | Est. total time | Notes |
|---------|-----------|----------------|-------|
| 1 | ~2 | ~50 hours | Current default |
| 5 | ~10 | ~11 hours | Manual multi-process hack |
| 10 | ~20 (projected) | ~5.5 hours | With proper worker pool |
| 20 | ~35 (projected) | ~3 hours | May hit API rate limits |

The 5x improvement from manual parallelism confirms the bottleneck is pure I/O wait. A proper worker pool with rate-limit-aware backoff should do better than raw process spawning.

## Non-goals

- Distributed workers across machines (Minions already handles this via job queue)
- Automatic concurrency tuning (start with manual `--workers`, tune later)
- Changing the checkpoint/resume model (terminal audit rows work fine)
