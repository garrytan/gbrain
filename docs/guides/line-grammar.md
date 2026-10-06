# Typed lines, wanted pages and similar-page hints

Three write-path features keep the graph honest without an LLM call: typed
relation and fact lines a person can type in any editor (opt-in), a queue of
link targets that have no page yet, and an opt-in "did you mean an existing
page?" hint when a write creates a page.

## Typed relation lines

Off by default; turn the line grammar on with
`gbrain config set line_grammar.enabled true`. While it is off, these lines are
ordinary list text and their links keep their inferred types. In the held-out
junk audit, the grammar read 18 of 696,295 list lines in public notes and
transcripts as grammar lines, and none of the 18 were real: all were fact
lines, mostly unfilled template slots (`- [Time] - [Event]`) and a few
dictionary usage labels. That failed the 0.95 precision bar. No relation line
was minted, and no timecode, citation, task box, date or machine-written
section was read.

When it is on, a list item that names a relation type and exactly one link
states that link's type:

```markdown
- works_at [[companies/acme-example]] (since 2024)
- "board member" [[companies/widget-co]] @effective[2022,)
```

The stated type wins over inference for the link on that line, on every
extraction path (local writes, sync, `gbrain extract`, the serve sweep). The
page is the subject. A line with words after the link is a sentence and keeps
the inferred type. Types must be verbs the active schema pack declares, the
same rule `add_link` follows; set `line_grammar.allow_undeclared_types true`
to accept any snake_case verb. The full convention for agents is
[`skills/conventions/line-grammar.md`](../../skills/conventions/line-grammar.md).

**Say to your agent:** *"Turn on typed relation lines, then record that alice-example works at acme-example since 2024 as a typed line on her page."*

## Fact lines

`- [category] claim #tag (context)` lines are read, linted and counted:
`put_page` reports them, `gbrain lint` explains near-misses, and
`gbrain schema detect --fields` lists the categories each page type uses.
They stay searchable page text; recall's facts come from `remember` and the
`## Facts` table.

## Validity ranges

`@effective[start,end)` (alias `@valid`) states when a relation or fact holds,
with `YYYY`, `YYYY-MM` or `YYYY-MM-DD` dates in UTC. Square brackets are
inclusive, parentheses exclusive, and an empty side is open. Ranges are parsed
and validated on write. A range on a relation line is stored on that relationship as dated
start and end evidence, the same evidence a dated timeline line gives
([temporal edges](temporal-edges.md)): `- works_at @effective[2021-03,2024-06) [[companies/acme-example]]`
makes the works_at edge live from 2021-03-01 and ended on 2024-06-01, so
default graph reads hide it and `as_of` reads find it. A range on a type that
is not a dated relationship, or on a link the page does not store with that
type, is reported and stores nothing. `gbrain config set line_grammar.effective_ranges false` turns
range storage off; the next extraction of each page drops its stored ranges.
Ranges are stored only while the line grammar is on.

## What `put_page` reports

```json
"line_grammar": {
  "relations": 1, "relations_state": "stored",
  "facts": 1, "facts_state": "page_text_only",
  "findings": [{ "severity": "warning", "validator": "line-grammar", "line": 5,
    "reason": "prose_tail", "text": "- works_at [[companies/acme-example]] since 2024",
    "message": "Text after the link makes this a sentence, so \"works_at\" is not applied. Put extra words in one trailing (context)." }],
  "total": 1, "details_truncated": false
}
```

`relations_state` is `pending_sweep` for a remote writer (links are reconciled
by the serve sweep), and `auto_link_disabled` when `auto_link` is off. Line
numbers count from the start of the page body.

## Wanted pages

A link whose target page does not exist is recorded instead of dropped. The
moment the target page is created (or restored, or renamed into place), the
linking page is due for re-extraction and the next sweep creates the edge.
`put_page` lists the missing targets in `auto_links.wanted`, and the
`wanted_pages` tool (`gbrain wanted`) lists every missing target with how many
pages link to it, most-referenced first. A bare-name link like
`[[Dave Example]]` whose name matches an existing page in another directory
shows that page in `existing_matches`, so the link can be rewritten by slug.
Remote callers never see targets that only private pages reference. Writes from remote agents record their missing
mention targets too (`wanted_pages.remote`, on by default).

**Say to your agent:** *"Which people and companies do my notes link to that don't have pages yet?"*

Off switch: `gbrain config set wanted_pages.enabled false`.

## Similar-page hints

Off by default; turn it on with `gbrain config set put_page.similar_pages true`.
In the held-out agent test, the hint cut duplicate pages from 3.06% to 2.22%,
but the 95% interval of that change ([−2.8, +1.1] points) includes zero, and
wrong merges rose from 2.50% to 3.75%, past the one-point limit. Claude Sonnet
5.5 behaved the same with and without it. All of the change came from
`gpt-6.1-sol`, whose duplicates fell from 2.8% to 1.1% while its wrong merges
rose from 5.0% to 7.5%.

When it is on and a write creates a page, a few indexed lexical checks look for
an existing page in the same source that is probably the same thing: the same
title, a declared alias, the same name in another directory, or a very similar
title in the same directory. Up to three slugs come back in `similar_pages` with
the evidence that matched. It is a question, never a merge: move the content
with `edit_page` and delete the new page if it is the same thing, keep both if
not. Semantic (embedding) duplicate detection is not part of this check
(`semantic: "not_checked"`).

**Say to your agent:** *"Before you file this, check whether we already have a page for this company."*

Turn off again: `gbrain config set put_page.similar_pages false`.

## Field usage

`gbrain schema detect --fields [--json]` reports, per page type, the
frontmatter keys, fact categories and relation types the pages use. A field on
every sampled page is listed as required, one on at least a quarter of them as
optional.
