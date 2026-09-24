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

Backtick and tilde code fences are excluded even when they contain headings
inside an attendee section. A closing fence must use the opening character,
have at least its length, and contain only trailing whitespace.

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

## Schema-pack boundary

Pack-owned relationship directions and inference rules are unchanged. This
includes the shipped `gbrain-base` and `company-brain` outgoing attendance
mappings: they do **not** gain incoming `Who attended` lookup from this change.
Inspect the active schema and its declared direction rather than reversing
those rows or disabling the pack as a workaround.

This change does not automatically repair historical links or run a full-brain
backfill. A repair on a real brain requires a separately approved, verified full
database backup; a Markdown export is not a rollback image. No native agent
harness activation or broad answer-accuracy improvement is implied.
