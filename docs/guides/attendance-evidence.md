# Explicit attendance evidence

Only a link's target can become its attendee. Names or slugs inside the link's
display label are not additional attendees.

When a schema pack does not override attendance, GBrain records a confirmed
person's attendance as `person --attended--> meeting`. It requires an explicit
attendance list, not a person mentioned somewhere in the meeting note.

**Say to your agent:** *"Who attended this meeting? Show the source, and don't
count people who were only invited or mentioned."*

## Supported evidence

On a `meeting` page, use canonical structured `attendees` frontmatter, a bare
`Attendees:` link list, or a dedicated `## Attendees` section containing only
bare link-list entries. Each reference must resolve unambiguously to a live
`person` page in the allowed source scope. For example:

```markdown
---
type: meeting
title: Planning
---

Attendees: [Alice Example](../people/alice-example.md)
```

An alternative body is:

```markdown
## Attendees
- [Alice Example](../people/alice-example.md)
```

Free prose, qualified lists, code examples, and ordinary mentions are not
canonical attendance evidence. Keep absent or invited-only people outside the
attendee list: a bare list asserts that each linked person attended, and link
labels are not a natural-language qualification parser. Unsupported or
ambiguous references remain mentions or unresolved references.

HTML comments and backtick and tilde code fences are excluded even when they contain headings
inside an attendee section. A closing fence must use the opening character,
have at least its length, and contain only trailing whitespace.
An inline comment beside a visible attendee does not make its hidden references
part of the attendee list, even when those references resolve to live people.
An example comment opener inside code does not hide real attendance below it.
When global basename resolution is enabled, a unique bare attendee wikilink
can resolve to a person; missing or ambiguous names remain incomplete.

The existing query surface can read the resulting relationship:

```bash
gbrain call query '{"query":"Who attended meetings/planning?","expand":false,"relational":true}'
```

The meeting owns the derived claim. Re-extracting the person does not delete
it; removing the attendance evidence and re-extracting the meeting does.
Manual claims and claims from other origins remain separate. Remote writes
still follow the existing deferred-maintenance rules in
[memory boundaries](memory-boundaries.md).

Filesystem extraction uses the file as evidence and the database for canonical
attendance endpoint types and source identities. A person does not need a local
Markdown file. Source-qualified references follow the same explicit opt-in,
federation, and configured-default rules as database extraction.

An unresolved or denied attendance reference is not a retraction. The origin's
derived graph stays unchanged, and extraction does not mark it processed or
advance its watermark. Local page publication still accepts the content,
reports an auto-link error, and leaves extraction retryable. Removing the
supported evidence entirely still retracts its owned attendance edge. Ordinary
filesystem links and schema-pack-owned mappings retain their existing behavior.
A linked page changing or disappearing between preparation and the locked
graph check has the same automatic-link error outcome: the note is saved, no
new graph delta is written, and later extraction can retry. This does not
suppress source/authority conflicts or unexpected storage failures.
DB and stale extraction report skipped incomplete-attendance pages; their JSON
summaries add `skipped_attendance_incomplete` only when it is nonzero. Sweep
reports `attendance_resolution_incomplete`, not a budget timeout, for that case.
Filesystem extraction omits incomplete pages from its processed set, but does
not currently provide a per-reason skip counter.

## Schema-pack boundary

An unavailable schema pack is not a pack with no attendance override. Link
extraction refuses before changing the graph when the active pack cannot load;
sweep reports a link/timeline pass error. Local publication still accepts the
note but reports an automatic-link error and preserves the prior graph. Repair
or restore the pack configuration, then retry extraction.

Pack-owned relationship directions and inference rules are unchanged. This
includes the shipped `gbrain-base` and `company-brain` outgoing attendance
mappings: they do **not** gain incoming `Who attended` lookup from this change.
Inspect the active schema and its declared direction rather than reversing
those rows or disabling the pack as a workaround.

This change does not automatically repair historical links or run a full-brain
backfill. A repair on a real brain requires a separately approved, verified full
database backup; a Markdown export is not a rollback image. No native agent
harness activation or broad answer-accuracy improvement is implied.

## Preview-bound historical repair

**Say to your agent:** *"Preview historical attendance links in source `notes`.
Show the proposed additions, removals and skipped origins. Don't apply anything
until I've reviewed that exact preview and verified a full database backup."*

Use the existing **trusted-local** DB extraction surface. It is unavailable to
MCP and thin clients. An explicit live source is required, even when a default
source is configured. DB-only meeting pages work without filesystem sync.
The literal source ID `default` must also exist and remain live: its incarnation
pins the brain identity even when repairing another source. Either archive
indicator on the selected source or `default` refuses preview and apply.

```bash
umask 077
mkdir -m 700 attendance-review
gbrain extract links --source db --repair-attendance --source-id notes --json \
  > attendance-review/preview.json
```

Preview writes no logical database rows, extraction watermarks, source files,
receipts or checkpoints. It opens an existing database without migrations or
automatic repair; a storage engine may still maintain its locks and WAL files.
The operator's shell creates the private receipt above. Keep it private: it
contains source-qualified page identities and hashes, but no copied source
text or evidence snippets. Review its `counts`, bounded `diagnostics`, `pack`,
`direction`, and `origins` before authorizing it.
Each preview invocation creates a new approval ID and exact digest, even when
it proposes no changes. Save and approve that exact receipt rather than
regenerating it between review and apply.
The connection pin hashes only the selected brain and its stable target:
the resolved PGLite path, or PostgreSQL scheme, ordered hosts/ports and database.
Credentials, userinfo, unrelated configuration and query option values do not
participate. PostgreSQL targets require explicit hosts and a database; ordered
multihost and bracketed IPv6 addresses are supported. Socket/service URLs,
query-based target overrides and malformed targets refuse rather than sharing
a fallback identity. Changing the target or brain requires a fresh preview;
rotating credentials alone does not. Previews from the older connection-pin
format also require a fresh preview.

The default window is **250 source pages**; `--limit` accepts 1–1000. The
indexed `(source_id, slug)` window is selected before filtering deleted or
nonmeeting pages. `counts.scanned` counts that window, while
`counts.eligibleOrigins` counts live meetings inside it. A window may have no
eligible origins. After applying a reviewed window, use `--after-slug` with
its `nextAfterSlug` to preview the next one. Each window requires a new preview,
confirmation and checkpoint file path. Do not reuse `cursor.json` with a new
preview: the checkpoint belongs to the exact approved receipt, so use names
such as `preview-002.json` and `cursor-002.json` for the next window.
Database ordering determines the cursor, including Unicode
and punctuation; a full-sized final window requires one more empty preview.
The cursor is a bounded traversal, not a snapshot across separate previews:
new or renamed pages behind it require another pass from the beginning.

Historical repair accepts only explicit Markdown attendance links. **All
frontmatter attendance is report-only**, including apparently canonical paths,
and existing frontmatter claims keep their IDs and evidence. Repair neither
loads frontmatter nor approximates the ordinary extractor's source-wide
title/alias uniqueness checks. Body targets use bounded, source-scoped exact
slug lookups; missing or ambiguous targets skip the origin without deletion.
Mixed person/non-person attendance lists are also report-only: repair does not
partially reinterpret them or delete earlier claims to make the list fit.

Each eligible origin is capped at 256 KiB of body text, 256 lookup slugs and
512 adjacent link rows of any type. Three capped adjacency probes each inspect
at most 513 logical IDs before selecting attendance edges. An over-limit
origin, proposed post-repair adjacency or oversized attendance evidence is
report-only. Oversized body and edge evidence are not transferred from the
database into the repair process. These are logical row and transfer bounds,
not physical MVCC page-scan or total-process-memory guarantees. At most 20
diagnostic details are retained, alongside aggregate counts. Retained origin
receipts above 16 MiB are refused; retry with a smaller window.

Repair preserves pack-owned outgoing attendance, including shipped base and
company-brain mappings. Missing packs are also report-only. It never guesses
ownership for NULL, unknown or manual producers. Legacy outgoing Markdown is
eligible only when authoritative source text proves the same resolved person's
attendance. Other derived/manual links keep their row IDs and evidence.

Before applying on a real brain, quiesce old extraction writers, verify a full
database backup and its recovery procedure, and obtain separate operator
approval. Copy the exact receipt's `digest` into the following command:

```bash
gbrain extract links --source db --repair-attendance --source-id notes \
  --apply-preview attendance-review/preview.json --confirm APPROVED_DIGEST \
  --yes --backup-verified --checkpoint attendance-review/cursor.json
```

`--backup-verified` acknowledges the operator's backup verification; it does
not perform or verify a backup. The receipt and checkpoint must be owned,
private regular files in an owned private directory. Symlinks are refused.
Filesystem, stale, global, parallel, mention/NER and timeline extraction flags
cannot be combined with repair. `--yes` alone never applies a new scan.

Each origin runs in its own transaction. Brain connection and source
incarnation, origin/endpoint IDs and revisions, parser/ontology identity,
reference resolution and exact affected edge rows are checked again. Changed
state refuses the preview instead of silently recalculating approval. The
transaction applies only the attendance delta and banks a private database
commit receipt; the private file cursor advances only after that commit.
Re-run the exact apply command after interruption. A commit before a cursor
write is recognized without deleting/reinserting identical rows. A failed
origin is not passed; changed state requires a fresh preview. The cursor also
covers revalidated deleted/nonmeeting prefixes and tails, including windows
with no eligible origins, but never passes an uncommitted origin. A successful
prefix remains committed if a later origin fails.

Version-2 approvals expire **seven days after their database-clock issuance
time**. The commit proof must independently remain within the existing global
**seven-day checkpoint pruning horizon**, measured from the proof row's update
time. A late apply or replay extends neither deadline. Version-1 receipts,
expired approvals and retained expired proofs require a fresh preview, new
confirmation digest and new checkpoint path. Repair has no pruning exemption.
If proof is pruned or otherwise lost, obtain and approve a fresh preview;
retaining the private cursor does not establish a database commit or extend
either lifetime. A still-young no-op approval with missing proof can be
indistinguishable from first apply when its approved pre-state is unchanged;
repair does not reconstruct missing commit history. Row-identity
preservation is an A2 repair/replay property, not a promise about other writers:
later ordinary DB re-extraction can preserve attendance semantics while changing
repaired row IDs, invalidating replay of the old preview. Preview again then too.

Each origin transaction takes a table-wide link lock, pausing link writers
across the database while ordinary PostgreSQL reads remain available. PGLite
retains its existing single-owner connection model. Lock waits are capped at
five seconds and individual statements at ten seconds; contention refuses the
current origin for retry. Existing normal extraction paths and their watermarks
are unchanged. Reverting the code does not undo a repair; recovery requires the
full database backup or a separately verified reverse repair.
