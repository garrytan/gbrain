# Line Grammar Convention

Two line shapes in a page's compiled truth carry structure that gbrain reads
with zero LLM calls. Write them when the relationship type or the fact
category is known; write prose for everything else.

gbrain reads these lines only when `line_grammar.enabled` is on, and it is off
by default. Check with `gbrain config get line_grammar.enabled`. While it is
off, a relation line is plain list text: its link keeps the inferred type, and
`put_page` returns no `line_grammar` block. Turn it on only when the user asks
or agrees (`gbrain config set line_grammar.enabled true`); for one typed edge
now, use `add_link` instead.

## Typed relation lines

```markdown
- works_at [[companies/acme-example]] (since 2024)
- invested_in [[companies/widget-co]] @effective[2021-03,) (seed)
- "board member" [[companies/widget-co]] [Source: User, chat, 2026-10-04]
```

- One list item: the relation type, then exactly one link, then optionally one
  `(context)` and a trailing `[Source: ...]` citation.
- The page is the subject: the line above on `people/alice-example` records
  `alice-example --works_at--> acme-example`.
- The type is one word in snake_case (`works_at`), or a quoted phrase
  (`"board member"` becomes `board_member`). `worksAt` and `works-at` also
  normalize to `works_at`.
- Use a verb the active schema pack declares. `gbrain schema stats` and
  `gbrain schema detect --fields` show the vocabulary; an undeclared verb falls
  back to the inferred type and `put_page` names the nearest declared one.
- Anything else after the link (`- works_at [[companies/acme-example]] since
  2024`) makes the line a sentence: the link keeps its inferred type and
  `put_page` explains why. Put extra words in the one trailing `(context)`.
- Lines under machine-written headings (Timeline, See also, Related, Sources,
  Links, Backlinks) are never read as relation lines.

## Fact lines

```markdown
- [preference] Prefers oat milk #coffee (since the almond allergy)
- [event] @effective[2024-03,2024-09) Led the pricing rework
```

- `[category]` is one word starting with a letter. `event`, `preference`,
  `commitment`, `belief`, `fact` and `idea` map to fact kinds; any other word
  is kept as the category.
- Fact lines are searchable page text and appear in `gbrain schema detect
  --fields`. They are not added to recall's facts: for a fact recall must
  return, call `remember` (or edit the page's `## Facts` table).
- Timecodes (`[00:00:11]`), dates (`[2024-01-01]`), task boxes (`[ ]`, `[x]`),
  citations (`[Source: ...]`) and bracketed phrases are never fact lines.

## Validity ranges

`@effective[start,end)` (alias `@valid`) after the type or category states when
it holds. Dates are `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (UTC). `[`/`]` are
inclusive, `(`/`)` exclusive, an empty side is open: `@effective[2022,)` means
"since 2022". Natural-language and relative dates (`last spring`) are not read.
The range on a relation line dates that relationship (`line_grammar.effective_ranges`,
on by default): an ended range hides the edge from default graph reads
(`get_links` with `status: all` or `as_of` still shows it). To record that a
job ended, edit the line's range rather than deleting the line.

## Check before writing

- `gbrain lint <file>` reports every near-miss with its fix (rule
  `line-grammar`).
- After `put_page`, read the `line_grammar` block: relations stored, fact lines,
  and findings. `auto_links.wanted` lists links whose target page does not
  exist yet; the edge appears once that page is created.
- To write a literal bracket or type at the start of a list item, escape it:
  `- \[draft] notes`.
