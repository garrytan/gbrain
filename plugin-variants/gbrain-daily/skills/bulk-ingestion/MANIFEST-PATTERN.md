# The Manifest Pattern — Durable State for Mass Ingestion

The state substrate for [bulk-ingestion](SKILL.md). Read this before Phase 2
(ACCESS) of any pipeline build, and at the start of ANY session that touches
a large in-flight ingest.

Battle-tested corpus shapes this pattern has carried (anonymized): an audio
lecture library (~650 files, transcribe → curate pipeline), an email takeout
(~400K messages, high-parallelism worker fan-out), a personal file archive
(~2,700 documents), and a messaging-history export (~6,500 threads).

## When to use

Any job where you process a large, enumerable set of source items in stages
and need to know — at any moment, after any crash, across any number of
subagents/workers — exactly what's done, what's in flight, and what's left.

If the set is >~20 items OR the job spans multiple sessions OR multiple
workers/subagents touch it: build the manifest FIRST, before processing
anything.

## The two-file model (non-negotiable)

```
projects/<pipeline-name>/manifest.json   <- SOURCE OF TRUTH. Machine-updatable. Idempotent.
projects/<pipeline-name>/MANIFEST.md     <- RENDERED human view. Generated FROM json. Never hand-edited.
```

Why split: the JSON is what workers read/write programmatically (status
updates, checkpoints) — editing markdown by hand would corrupt state and
lose idempotency. The MD exists so the user (and you, at a glance) can see
progress, per-group rollups, and per-item status without parsing JSON.
**Regenerate the MD from JSON on every state change**, or on demand. They
must never disagree.

## manifest.json schema

Top-level: separate the item list, the rollup, and the run history.

```json
{
  "version": 1,
  "project": "lecture-library-curation",
  "source": "object-store:archive-bucket/lectures/",
  "updated": "2026-08-11T17:35:59Z",
  "pipeline": ["pending", "transcribed", "curated"],
  "summary": {
    "total": 650, "curated": 51, "transcribed": 2, "pending": 597,
    "total_pages": 212, "total_gb": 5.1
  },
  "by_group": {
    "collection-01": {"total": 7, "curated": 7, "transcribed": 0, "pending": 0, "pages": 36}
  },
  "items": [
    {
      "id": "collection-01/lecture-01-01.mp3",
      "group": "collection-01",
      "basename": "lecture-01-01.mp3",
      "size_mb": 10.1,
      "status": "curated",
      "outputs": {
        "transcript": "media/audio/lectures/transcripts/collection-01/lecture-01-01.md",
        "pages": 3
      },
      "checksum": null,
      "notes": null
    }
  ],
  "runs": [
    {"timestamp": "2026-08-11T14:00Z", "stage": "transcribe", "items_processed": 15, "worker": "chunkA", "outcome": "ok"}
  ]
}
```

Field rules:

- **`id`** — stable, unique, derived from the source path/key (NOT a row
  index; indexes shift). For files: the source-relative path. For emails: a
  thread hash. For posts: the post id. This is the same key as the
  pipeline's dedup key (SKILL.md Phase 1d).
- **`status`** — one value from `pipeline`. The pipeline array defines the
  legal stage order so tools can compute "next stage" generically.
- **`outputs`** — where the produced artifact(s) live + counts. Presence of
  an output is how status is VERIFIED, not asserted.
- **`group`** — the natural partition (collection / folder / era / tier)
  for rollups and worker chunking.
- **`runs`** — append-only history; each worker/stage execution logs what it
  did. This is your audit trail and your "did the subagent actually do it"
  check.

## Build the manifest from GROUND TRUTH (never from memory)

The #1 failure mode: declaring an archive "done" by looking at the OUTPUT
folder instead of re-scanning the SOURCE. (One production run called a
corpus "exhausted" at 8% complete because only the transcript folder was
checked, not the 650-file source.)

Build/refresh procedure:

1. **Enumerate the source authoritatively.** Object-store recursive listing,
   mbox stream count, archive API walk, `find` on a corpus dir. Get the
   FULL set.
2. **Match outputs back to source by identity**, not by guessing. For each
   source item, look for its artifact: grep output frontmatter for the
   `source_path` (or equivalent stored backlink) that points back to this
   item. Match by the stored backlink, never by re-deriving slugs —
   slugification is lossy and drifts.
3. **Derive status from artifact existence**, not assertion: `pending` (no
   output) → mid-pipeline stages (partial outputs) → final stage (all
   outputs present).
4. **Recompute `summary` + `by_group`** by aggregating items. Never maintain
   counters by hand — they drift. Always recompute from `items`.
5. **Write JSON, then render MD from it.** Commit both.

A refresh is idempotent: re-running it on a half-done job produces the
correct current state. Run it at the start of every session that touches
the job.

## MANIFEST.md rendering

Generated from JSON, never hand-edited. Structure:

- **Frontmatter**: `type: manifest`, the summary numbers, `updated`.
- **Overall progress table**: status | items | %.
- **Progress by group**: group | total | per-status counts — sorted so
  in-progress groups float to the top.
- **Item-level manifest**: grouped by `group`, one line per item with a
  status icon, size, and output counts.

Icons map to pipeline position generically: last stage = ✅, any middle
stage = 📝, first stage = ⬜.

## Worker / subagent contract (idempotency + verification)

**No atomic claim — partition the work-list UP FRONT.** The manifest is a JSON
file, not a database: there is no compare-and-swap, no row lock, no atomic
"claim this item." Workers that race a shared `status` field to decide what to
process WILL collide — two workers read `pending`, both process the same item,
and you pay twice for the same expensive extraction; worse, two workers writing
the same `manifest.json` concurrently can interleave and corrupt the JSON,
losing the whole run's state. `git pull --rebase` is NOT synchronization — it
resolves text conflicts, it does not prevent two workers from having already
done the same paid work. So the claim is made by PARTITIONING before fan-out:
split the item list into DISJOINT shards (by `group`, or by an offset/limit
range) and hand each worker its own shard. No two workers ever look at the same
`id`. Idempotent restart (below) then covers only the crash-and-rerun case
within a shard, not cross-worker contention.

When fanning out processing across chunks/workers/subagents:

1. **Workers own a disjoint shard, write by `id`.** Each worker takes its
   pre-assigned slice (a group, or an offset/limit range) and processes only
   those items, updating status + outputs in the JSON (or writing a per-worker
   progress file that's merged — see below). It never scans the whole manifest
   for "any pending item" — that is the racing pattern the partition exists to
   prevent.
2. **Idempotent restart.** Before processing an item, check its current
   status. If already at/past the target stage, skip. A killed worker
   re-run does no double work.
3. **Checkpoint frequently.** Update state every item (small jobs) or every
   N items (large). Commit/flush so a crash loses at most N items, never
   the run. For expensive per-item outputs, write one artifact per item and
   commit per group, so a single provider-side failure costs one item, not
   the whole chunk.
4. **NEVER trust a subagent's "completed successfully."** Runtimes can
   mislabel provider-blocked or crashed runs as success. VERIFY on disk:
   re-run the ground-truth refresh and confirm the item's outputs actually
   exist + counts match before advancing its status. The manifest refresh
   IS the verification. (This is the same discipline
   `skills/minion-orchestrator/SKILL.md` applies to job results — inspect
   outputs, not exit claims.)
5. **Concurrency ceiling.** As a rule of thumb: max ~3 heavy subagents or
   ~20 light workers, and keep CPU below ~75% so lock heartbeats and
   checkpoints keep firing.

### Per-worker progress files (for high parallelism)

When many workers run concurrently, having them all write one JSON races.
Instead each writes `worker-<id>-progress.json` with
`{"processed_ids": [], "stats": {}}`; a merge step folds them into the
master manifest. (Proven at 20 workers on an email-takeout ingest.) For low
parallelism (<=4 chunks), direct per-item JSON updates with a
`git pull --rebase` before each commit is simpler and fine.

## Periodic commit during long runs

Long ingests need a heartbeat commit so work survives a crashed session.
Schedule it via `skills/cron-scheduler/SKILL.md`, executed through Minions
per [conventions/cron-via-minions.md](../conventions/cron-via-minions.md) —
a recurring shell job shaped like:

```bash
gbrain jobs submit shell --params '{"cmd": "cd <brain-repo> && git add projects/<pipeline-name> <output-dirs> && git commit -m \"<pipeline-name> ingest checkpoint\" && git push"}'
```

Shell jobs require `GBRAIN_ALLOW_SHELL_JOBS=1` on the WORKER environment — see
minion-orchestrator Preconditions. Do not set it yourself: it is an RCE-class
authorization that belongs to the operator running the daemon, and a submit-side
env prefix (`GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit ...`) is a no-op in
the daemon lane anyway (the worker's environment decides, not the submitter's).

Pre-commit hooks (privacy/durability) intentionally run on checkpoint
commits — a checkpoint that bypasses them can bank unlintable content.
Stage explicit paths, never `git add -A` (sweeps unrelated churn). Remove
the schedule when the job completes.

## Hard rules

1. **JSON is truth; MD is a view.** Regenerate MD from JSON; never
   hand-edit MD.
2. **Rebuild state from GROUND TRUTH** (re-scan source + verify outputs on
   disk). Never trust memory, a counter, or a subagent's success claim.
3. **`id` is a stable source-derived key**, never a row index.
4. **Status is DERIVED from artifact existence**, not asserted.
5. **Recompute summary/by_group from items** on every write — never
   maintain by hand.
6. **Match outputs to source by stored backlink** (`source_path`-style
   frontmatter), never by re-deriving slugs.
7. **Idempotent workers**: check status before processing; safe to restart.
   No atomic claim exists — partition the work-list into disjoint shards up
   front; never race a shared `status` field (double-processes paid work,
   corrupts the JSON).
8. **Checkpoint + commit frequently**; a crash loses at most one batch.
9. **Never declare a corpus "done" by looking at the output folder** —
   re-scan the source and diff. (The 8%-called-100% bug.)
10. **Stage explicit paths on commit**; the manifest + outputs should be
    reviewable from the repo history.

## Boundaries

- **Native `gbrain sync` checkpoints** cover resumable file sync for brain
  repo sources only. The manifest covers arbitrary external corpora and
  multi-stage pipelines (transcription, extraction, curation) that sync
  knows nothing about.
- **Minion job progress** (`gbrain jobs`) is per-job and DB-backed; the
  manifest is per-CORPUS and survives across any number of jobs, sessions,
  and workers. Use both: jobs report liveness, the manifest holds truth.
- **`skills/archive-crawler/SKILL.md`** renders human-readable status
  tables for triage projects — that's the human-view half only. Any
  archive-crawler follow-up that processes items in stages should adopt
  this JSON-truth model underneath.
