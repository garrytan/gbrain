# Conversation backfill durable outcomes

`gbrain extract-conversation-facts` stores page-level outcomes in `facts` so
bulk runs, autopilot, and `gbrain doctor` can distinguish finished work from
retryable work without adding another state table.

This is completion authority, not ordinary extracted knowledge. The authority
is deliberately narrow: a marker is valid only for the exact page or transcript
snapshot that was parsed, and only after every required operation succeeded.

## Outcome protocol

The current protocol is v2. Its source names are versioned so rows written by
older best-effort implementations cannot suppress a corrective replay.

| Outcome | `facts.source` | Meaning |
|---|---|---|
| Complete | `cli:extract-conversation-facts:terminal:v2` | Every eligible segment was extracted and inserted successfully, the input remained unchanged, and the terminal write succeeded. |
| Scanned, not extractable | `cli:extract-conversation-facts:non-extractable:v2` | A recognized input was scanned successfully but contained no eligible multi-message segment. |
| Unfinished | no matching v2 outcome | Work is pending, failed, was not recognized, changed during extraction, or has only a legacy marker. |

The non-extractable outcome is intentionally separate from completion. It does
not claim that knowledge facts were extracted. CLI counters, cycle details, and
doctor output preserve that distinction.

## Snapshot identity

Every v2 marker binds `source_session` to the parser input snapshot:

```text
<outcome-source>:<page-slug>:<version-token>
```

There are two token forms.

### Database-backed page body

For pages parsed from `compiled_truth` and `timeline`, the token is:

```text
page-<pages.content_hash>-<effective-date>
```

`content_hash` covers title, type, compiled truth, timeline, and frontmatter.
The effective-date suffix covers the remaining date input used by parsing. This
identity does not depend on JavaScript's millisecond timestamp precision, so two
writes within one PostgreSQL millisecond still produce different tokens when
parser input changes. A legacy page with a null content hash uses a computed
SHA-256 fallback and is verified in-process by both extraction and doctor.

### Raw transcript sidecar

When frontmatter contains `raw_transcript`, the source text lives outside the
page row and may change without changing `pages.updated_at`. Its token is:

```text
sidecar-<SHA-256>
```

The digest covers the exact body given to the parser plus parser-relevant page
metadata: title, type, frontmatter, and effective date. Selection recomputes
the digest before skipping work. A sidecar-only edit therefore reopens the page.

`gbrain doctor` cannot read sidecars in its SQL aggregate, so it enumerates those
pages in bounded batches and calls the same canonical verifier used by
extraction. Doctor and extraction therefore agree after sidecar-only edits.

## Selection and locking

Bulk extraction follows this sequence:

1. Enumerate candidate pages in bounded batches.
2. Filter candidates with matching v2 outcomes.
3. Apply `--limit` to the remaining pages that actually need work.
4. Acquire the source-and-slug advisory lock.
5. Re-fetch the page under that lock.
6. Recompute and recheck the snapshot-bound outcome.
7. Prepare one immutable parser snapshot and process it.
8. Re-fetch and recompute the snapshot before writing an outcome.

The pre-lock check avoids parser, filesystem, and model work for ordinary
completed pages. The under-lock refetch prevents a stale enumeration object
from becoming the certified input. The final comparison prevents an edit that
happens during model or insertion work from receiving a marker for old content.

An edit can occur after the final comparison and before marker insertion. That
is still safe because the marker contains the old version token. Future
selection compares the token, not marker creation time, and reopens the page.

Single-page `--slug` runs use the same under-lock path.

## Strict extraction success

The general `extractFactsFromTurn` API remains best-effort for interactive
callers. It historically returns an empty array for both a legitimate zero-fact
answer and several model failures.

Conversation backfill instead uses `extractFactsFromTurnWithOutcome`, whose
result separates:

- `{ ok: true, facts: [] }`, a successful extraction with no durable facts;
- `{ ok: true, facts: [...] }`, a successful extraction with facts; and
- `{ ok: false, reason, error? }`, an unavailable provider, provider error,
  refusal, content filter, malformed output, or repeated truncation.

Any failed segment aborts the page attempt. Any `insertFacts` failure also
aborts it. The page receives neither a checkpoint advancement nor a terminal
outcome. Facts inserted by earlier segments may remain temporarily, but the
next claim deletes this command's rows for the page and replays cleanly.

Bulk workers continue past an individual page failure, but they do not hide it.
`pages_failed` counts failed claims, stderr names each page, the CLI exits 1,
the autopilot phase reports `warn`, and receipts/rollups classify the run as
incomplete. A tolerant pool is therefore observable without sacrificing the
rest of a large backfill.

This distinction is load-bearing. Treating a provider outage as a successful
zero-fact response would make a transient failure durable and permanently hide
the page from later runs.

## Non-extractable authority

A non-extractable marker is written only when all of the following are true:

- a deterministic or accepted parser format recognized the input;
- ordinary segmentation produced no eligible multi-message segment;
- the parser phase was not `no_match`;
- cleanup of prior command-owned rows succeeded; and
- the input snapshot was still current immediately before cleanup and write.

A `no_match` result stays unfinished so a new parser pattern, optional fallback,
or corrected input can recover it. Oversize pages, disappeared pages, lock
contention, dry runs, aborts, cleanup errors, provider failures, extraction
failures, insertion failures, and outcome-write failures also stay unfinished.

Cleanup errors are never interpreted as "zero rows deleted." Propagating them
prevents a fresh non-extractable marker from coexisting with stale extracted
facts that could not be removed.

## Checkpoints are not authority

Operation checkpoints are only progress hints. They do not prove which page
snapshot was processed, and old checkpoint entries do not include a snapshot
token. When a page lacks a matching v2 outcome, the command discards that
page's checkpoint entry and performs a delete-first full replay.

This rule prevents two corruption classes:

- edited text with timestamps older than the old watermark being skipped; and
- command-owned facts being deleted while the checkpoint skips the segments
  needed to recreate them.

Deleting `op_checkpoints` does not reopen pages with matching v2 outcomes.
Deleting or editing an outcome does not make a checkpoint authoritative.

## `--limit` semantics

`--limit N` caps pages that require processing, not completed pages inspected
while finding them. Durable filtering happens before clipping a batch. With a
completed page first and a pending page second, `--limit 1` processes the
pending page rather than consuming the limit on the completed page.

`pages_considered` may therefore exceed `--limit` because it includes durable
outcomes observed during selection. Model-bearing page work does not exceed the
limit.

## `--force`

`--force` bypasses durable outcome selection and clears the page checkpoint.
It still uses delete-first replay, strict extraction outcomes, advisory locks,
and snapshot verification. Force means "recompute" rather than "relax safety."

## Operator signals

The result exposes separate counters:

- `pages_skipped_completed`
- `pages_skipped_non_extractable`
- `pages_marked_non_extractable`
- `pages_failed`

The CLI aggregates these across sources. The autopilot backfill phase includes
them in phase details. `gbrain doctor` reports `completed`,
`scanned_not_extractable`, and `backlog` independently.

Run a small canary twice:

```bash
gbrain extract-conversation-facts --source-id default --limit 10 --workers 1 --max-cost-usd 0.25 --yes
gbrain extract-conversation-facts --source-id default --limit 10 --workers 1 --max-cost-usd 0.25 --yes
gbrain doctor
```

On the second run, unchanged pages should move through durable skip counters.
Edit one page or raw transcript sidecar and rerun; that page should process
again and receive a marker with a new token.

## Maintainer contracts

- Version completion protocols when their success guarantees change.
- Require an exact `source`, page slug, and snapshot-bound `source_session`.
- Keep completion and non-extractable as different sources and counters.
- Re-fetch after acquiring the lock; never certify the enumeration object.
- Revalidate the snapshot before writing either durable outcome.
- Keep sidecar content in the version identity.
- Keep regular-page content hash and effective date in the version identity.
- Never turn model, insertion, cleanup, cancellation, or parser failures into
  successful empty extraction.
- Never classify `no_match` or dry-run output as a durable negative.
- Do not make operation checkpoints completion authority.
- Apply work limits after durable filtering.
- Keep doctor source-scoped by both page and fact `source_id`.
- Give terminal completion precedence if both current outcome rows exist.
- Update CLI and cycle aggregation whenever a result counter changes.

## Focused verification

```bash
bun test test/extract-conversation-facts.test.ts
bun test test/doctor-conversation-facts-backlog.test.ts
bun x tsc --noEmit
```

The focused suite covers checkpoint garbage collection, same-timestamp edits,
edits during extraction, sidecar-only edits, legacy marker replay, provider and
insert failures, cleanup failure, recognized non-extractable scans, retryable
parser misses, post-filter limits, force replay, and doctor accounting.
