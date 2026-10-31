# Anatomy of a page

A gbrain page is one Markdown file with a fixed shape. Most of it is free text an
agent or a person writes, and a few parts have a format gbrain reads and writes
exactly: the YAML frontmatter at the top, the timeline below a sentinel line,
and the fenced facts and takes tables. This page shows each part once, on a
real page, and links to the reference that owns it.

The path decides the page's slug: `companies/client-a-example.md` is the page
`companies/client-a-example`.

## An annotated example

This is the file gbrain wrote for a company page after one `gbrain put`, one
`gbrain remember` and one `gbrain timeline-add` (PGLite, gbrain-base-v2):

```markdown
---
type: company
title: Client A Example
subtype: company
trust_tier: agent_written
ingested_at: '2026-10-27T19:14:03.639Z'
source_kind: put_page
ingested_via: put_page
---

A prospect.

## Facts

<!--- gbrain:facts:begin -->

| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Quoted annual price is $5,000 | fact | 1.0 | world | medium | 2026-10-27T19:14:05Z |  | pricing call 2026-10-20 |  |
<!--- gbrain:facts:end -->

<!-- timeline -->

## Timeline

- **2026-10-20** | Meeting notes — Pricing call; quoted the annual plan
```

| Part | Lines | What it is |
|---|---|---|
| Frontmatter | from the first `---` to the second | YAML keys about the page. See [frontmatter keys](#frontmatter-keys). |
| Compiled truth | everything after the frontmatter and above `<!-- timeline -->` | The current synthesis, in prose. An agent rewrites it when the evidence changes. It can hold the facts and takes fences. |
| Facts fence | `<!--- gbrain:facts:begin -->` to `<!--- gbrain:facts:end -->` | One row per saved claim about the page's subject. See [fences](#facts-and-takes-fences). |
| Timeline sentinel | `<!-- timeline -->` | Splits compiled truth from the timeline. |
| Timeline | everything below the sentinel | Dated evidence, one bullet per event. New entries are added in date order; existing ones aren't rewritten. See [timeline rows](#timeline-rows). |

## Frontmatter keys

Frontmatter is ordinary YAML. Any key may appear, and gbrain keeps keys it
doesn't know. These are the ones it reads:

| Key | What gbrain does with it |
|---|---|
| `type` | The page type, one of the types the active schema pack declares (`person`, `company`, `concept`, `deal`, ...). When it is missing, the pack infers it from the path prefix (`people/` → `person`). Search and query filter on it (`--types`). |
| `title` | The display title. Without one, gbrain uses the first `# ` heading, then the file name. |
| `tags` | A list of tags. |
| `aliases` | Other names for the page. Entity lookup (`entity`, `recall <name>`, `remember --entity <name>`) and `gbrain whois` match them. A wikilink resolves by slug or file name, so write `[[people/alice-example]]` for a dependable link. |
| `email`, `emails` | Exact identity for `gbrain whois`. |
| `visibility` | `private` hides the page from remote (MCP) callers by default and keeps facts derived from it private; on a [git-canonical](../designs/GIT_CANONICAL_MEMORY.md) source a private page is never committed. A page without `visibility` is normally world, but some are private anyway: privacy aliases such as `access: private`, derived pages whose origin is private, and pinned-question pages. See [what confines remote callers](../architecture/brains-and-sources.md#what-confines-remote-callers-and-what-does-not). |
| `status` | A free-form state such as `draft` or `archived`, returned on every search row. |
| `event_date`, `date`, `published`, `created` | The page's content date (`effective_date`), used by `--since`/`--until` and recency. Precedence: `event_date`, `date`, `published`, a leading `YYYY-MM-DD` in the file name, then `created` (or `created_at`, `date_created`). Under `daily/` and `meetings/` the file name comes first. |
| `slug` | Optional. When present it must name the same page as the path, or the write is refused and sync holds the file ([`frontmatter_slug_conflict`](write-refusals.md#frontmatter_slug_conflict)). |

gbrain stamps a few keys itself: `subtype` (the finer kind gbrain-base-v2 records
next to the type), `trust_tier` (who the content came from; see
[memory trust](memory-trust.md)), and `ingested_at`, `source_kind` and
`ingested_via` (how the page arrived). Leave them as written.

Quote a value that contains `: ` (an email subject such as `Re: pricing`).
gbrain quotes the common cases before parsing; sync holds a file whose
frontmatter still doesn't parse ([`invalid_frontmatter`](write-refusals.md#invalid_frontmatter))
instead of guessing.

## Timeline rows

Below `<!-- timeline -->` each event is one bullet:

```text
- **YYYY-MM-DD** | Source — Summary
```

The date is bold, a `|` separates it from the source, and an em dash
separates the source from the summary. `gbrain timeline-add <slug> <date>
<summary> --source <source>` (MCP `add_timeline_entry`) writes this form, and
sync turns each bullet into a timeline row. Older files that split at
`--- timeline ---`, or at a `---` line directly above `## Timeline`, still
parse; gbrain writes `<!-- timeline -->`. The
[compiled truth and timeline pattern](compiled-truth.md) explains how agents
keep the two halves honest: rewrite the truth, append to the timeline, and
trace every claim in the truth to a timeline entry.

## Facts and takes fences

A **facts** fence holds what is true about the page's subject. Each row has a
row number, the claim, its kind (`event`, `preference`, `commitment`,
`belief`, `fact`, `idea`), confidence, visibility (`world` or `private`),
notability, `valid_from` / `valid_until`, a source and context. gbrain writes
those 10 columns; five optional ones carry a typed metric (`claim_metric`,
`claim_value`, `claim_unit`, `claim_period`) and who asserted the claim
(`attributed_to`). A struck-through claim (`~~claim~~`) is no longer active.

A **takes** fence holds who believes what, and how strongly: claim, kind
(`fact`, `take`, `bet`, `hunch`), holder (`who`), weight and since.

Don't hand-write these tables. `remember` adds a fact row and `takes_add` a
take row, each with a valid row number. When a fence is malformed, gbrain fixes
what has one exact meaning and holds the rest. Every column, value and repair
rule is in the generated [fence format](fence-format.md) reference.

## Types come from the schema pack

The active schema pack says which types exist, which folders they live in and
which types facts are extracted from. The default pack, gbrain-base-v2, has 14
canonical types plus `note` as the catch-all, and a few internal types gbrain
writes itself; see the [type taxonomy](../architecture/type-taxonomy.md).
`gbrain schema show` prints the active pack, `gbrain schema explain <type>`
one type's settings, and `gbrain schema lint` checks a pack. MCP agents use
`schema_explain_type` and `schema_lint`. To change the shape of your brain,
see [schema packs](../architecture/schema-packs.md) and the
[schema author tutorial](../schema-author-tutorial.md).

## Where to go next

- [Recommended schema](../GBRAIN_RECOMMENDED_SCHEMA.md): the directory layout
  (`people/`, `companies/`, `concepts/`, ...) and the filing rules agents follow.
- [Compiled truth and timeline](compiled-truth.md): how to update a page.
- [Fence format](fence-format.md): every facts and takes column.
- [Type taxonomy](../architecture/type-taxonomy.md): the default types.
- [Where your memory lives](where-your-memory-lives.md): which copy of a page is
  the record, and what to back up.
