# Facts and takes fence format

A page keeps its structured rows in two kinds of fenced Markdown tables: a
**facts** fence (what is true about the page's subject) and a **takes** fence
(who believes what, and how strongly). This page is the exact format gbrain
accepts, what it fixes in a malformed fence by itself, and what it never
guesses. Everything between the generated markers below is rendered from the
parser and repair code, so it matches the running gbrain.

**Say to your agent:** *"Why was my facts table held? Show me what the fence
should look like."*

**Say to your agent:** *"Add this as a take held by alice-example, not by hand
in the table."*

Prefer the structured writers to hand-written tables: `remember` adds a fact
row and `takes_add` adds a take row, each with a valid row number, kind and
holder, so the fence never needs repair. Write a table by hand only when the
user asks for it, and follow the format below.

When a fence does not follow this format, gbrain fixes what has one exact
meaning in the same write and holds or refuses the rest with an
`invalid_fence` reason ([what each reason means](write-refusals.md#invalid_fence)).
On the brain host, `gbrain repair fences` previews and applies the remaining
repairs, and the maintenance run applies them automatically
([fence repair](repair.md#fences)).

<!-- BEGIN GENERATED fence-format (bun run scripts/build-fence-format.ts; drift test: test/fence-format-reference.test.ts) -->
<a id="markers"></a>
## Markers

A facts fence sits between `<!--- gbrain:facts:begin -->` and `<!--- gbrain:facts:end -->`; a takes fence between `<!--- gbrain:takes:begin -->` and `<!--- gbrain:takes:end -->` (three dashes after `<!`). The body and the timeline section of a page each hold at most one fence of each kind. A marker inside a code block or an inline code span is an example, not a fence. Inside the fence the first table line is the header, which names `claim` and `kind`, then a separator line, then one line per row. A `|` inside a cell is written `\|`.

<a id="facts-columns"></a>
## Facts columns

Facts cells are read by position.

| Position | Column | Values | May be left off the row end | Default when the header lacks it | Meaning |
| --- | --- | --- | --- | --- | --- |
| 1 | `#` | a positive whole number | no | - | Row number. |
| 2 | `claim` | free text | no | - | The statement, free text. `~~claim~~` marks a row that is no longer active. |
| 3 | `kind` | `event`, `preference`, `commitment`, `belief`, `fact`, `idea` | no | - | What the claim is. |
| 4 | `confidence` | a number from 0 to 1 | no | `1.0` | How sure the brain is. |
| 5 | `visibility` | `private`, `world` | no | `private` | Who may read the row. |
| 6 | `notability` | `high`, `medium`, `low` | no | `medium` | How much it matters. |
| 7 | `valid_from` | free text | no | - | When it became true (`YYYY-MM-DD`), or empty. |
| 8 | `valid_until` | free text | no | - | When it stopped being true, or empty. |
| 9 | `source` | free text | no | - | Where it came from, free text. |
| 10 | `context` | free text | yes | - | Free text. `superseded by #N` names the row that replaced a struck row; `forgotten: ...` marks a row withdrawn with `forget`. |
| 11 | `claim_metric` | free text | yes | - | Metric of a typed claim (`mrr`, `team_size`, ...), or empty. |
| 12 | `claim_value` | a number, optionally with 1,234 separators or a k/M/B suffix | yes | - | Value of a typed claim. |
| 13 | `claim_unit` | free text | yes | - | Unit (`USD`, `people`, ...), or empty. |
| 14 | `claim_period` | free text | yes | - | Period (`monthly`, `annual`, ...), or empty. |

<a id="facts-layouts"></a>
- **Narrow, 10 cells** (what gbrain writes unless a row needs a wide column):

  ```text
  | # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
  |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
  ```

- **Wide, 14 cells** (adds `claim_metric`, `claim_value`, `claim_unit`, `claim_period`):

  ```text
  | # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
  |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
  ```

- **Shortest row, 9 cells:** the narrow row without `context`. A row that is short anywhere else is `short_row`.

<a id="takes-columns"></a>
## Takes columns

Takes cells are read by position, except `resolved`, `quality`, `evidence`, `value`, `unit`, `by`, which are read by header name.

| Position | Column | Values | May be left off the row end | Default when the header lacks it | Meaning |
| --- | --- | --- | --- | --- | --- |
| 1 | `#` | a positive whole number | no | - | Row number. |
| 2 | `claim` | free text | no | - | The position, free text. `~~claim~~` marks a row that is no longer active. |
| 3 | `kind` | `fact`, `take`, `bet`, `hunch` | no | - | What the take is. |
| 4 | `who` | `world`, `brain`, `people/<slug>`, `companies/<slug>` | no | - | Who holds the position (see [holders](#holders)): who said or clearly implied it, not who it is about. |
| 5 | `weight` | a number from 0 to 1 | no | - | How strongly it is held; stored on the 0.05 grid. There is no default. |
| 6 | `since` | free text | no | - | When the holder took the position (`YYYY-MM-DD` or `YYYY-MM`; `start → end` for a range). |
| 7 | `source` | free text | yes | - | Where it came from. `superseded by #N` names the row that replaced a struck row. |
| 8 | `resolved` | free text | yes | - | When the take was resolved. Read by header name. |
| 9 | `quality` | free text | yes | - | How the take turned out. Read by header name. |
| 10 | `evidence` | free text | yes | - | What resolved it. Read by header name. |
| 11 | `value` | free text | yes | - | Resolved value. Read by header name. |
| 12 | `unit` | free text | yes | - | Unit of the resolved value. Read by header name. |
| 13 | `by` | free text | yes | - | Who resolved it. Read by header name. |

<a id="takes-layouts"></a>
- **Narrow, 7 cells** (what gbrain writes unless a row needs a wide column):

  ```text
  | # | claim | kind | who | weight | since | source |
  |---|-------|------|-----|--------|-------|--------|
  ```

- **Wide, 13 cells** (adds `resolved`, `quality`, `evidence`, `value`, `unit`, `by`):

  ```text
  | # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |
  |---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|
  ```

- **Shortest row, 6 cells:** the narrow row without `source`. A row that is short anywhere else is `short_row`.

<a id="holders"></a>
## Holders

A takes `who` cell is one of `world`, `brain`, `people/<slug>`, `companies/<slug>`. Slugs are lowercase.

| Written | Valid | What gbrain does |
| --- | --- | --- |
| `world` | yes | Accepted. |
| `brain` | yes | Accepted. |
| `people/alice-example` | yes | Accepted. |
| `companies/acme-example` | yes | Accepted. |
| `alice-example` | yes | Accepted (an older bare-slug form); write `people/<slug>` or `companies/<slug>` instead. |
| `System` | no | Rewritten to `brain` (`holder_alias`). |
| `Alice Example` | no | Not a holder: `holder_unresolved`. Tier 2 resolves it only to one verified page; otherwise a person fixes it. |
| `people/Alice-Example` | no | Not a holder: `holder_unresolved`. Tier 2 resolves it only to one verified page; otherwise a person fixes it. |
| `world/alice-example` | no | Not a holder: `holder_unresolved`. Tier 2 resolves it only to one verified page; otherwise a person fixes it. |
| `users/alice-example` | no | Not a holder: `holder_unresolved`. Tier 2 resolves it only to one verified page; otherwise a person fixes it. |

<a id="row-numbers"></a>
## Row numbers

- `#` is a positive whole number, unique per fence kind across the whole page: the body and the timeline count together.
- A struck row keeps its number, and `superseded by #N` must name a row on the page.
- gbrain renumbers a row whose number is zero, negative, not a number or a duplicate. When two rows share a number, the row that matches the stored row keeps it. A new number is one above every number on the page (live and struck, both sections) and every stored row number of the page, so a freed number is not reused. A number whose only trace was deleted before this release is not known and could be reused.
- gbrain does not renumber a duplicate that a `superseded by #N` reference names (`superseded_ambiguous`), or rows hidden from a remote caller.

<a id="examples"></a>
## Examples

A valid facts fence (narrow layout; row 2 was superseded by row 3):

```markdown
<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Acme Example plans to open its widget API in 2026 | event | 0.9 | private | high | 2026-03-01 |  | meetings/2026-04-03 |  |
| 2 | ~~Acme Example has 12 engineers~~ | fact | 1.0 | private | medium | 2025-06-01 | 2026-01-15 | companies/acme-example | superseded by #3 |
| 3 | Acme Example has 18 engineers | fact | 1.0 | private | medium | 2026-01-15 |  | companies/acme-example |  |
<!--- gbrain:facts:end -->
```

A valid takes fence (narrow layout):

```markdown
<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Acme Example reaches profitability in 2027 | bet | people/alice-example | 0.65 | 2026-04 | meetings/2026-04-03 |
| 2 | Widget pricing drives most churn | take | brain | 0.55 | 2026-04 |  |
| 3 | Acme Example sells developer tools | fact | world | 1.0 | 2026-01 | companies/acme-example |
<!--- gbrain:takes:end -->
```

<a id="normalized"></a>
## What gbrain fixes by itself

These rules run on every write path for free. They edit or move cell text and never re-render a table. A fence they fix completely is written back in fixed form; each fix is reported by its class, row and column.

| Class | What it rewrites |
| --- | --- |
| `merge_fences` | A section with more than one fence of a kind becomes one fence when every fence has both markers, the same canonical header and nothing but table lines inside: the later fences' rows are appended to the first in document order, a later row whose cells (every column but `#`) equal a kept row's as written is dropped, a number that now collides is renumbered (see [row numbers](#row-numbers)) and a `superseded by #N` reference follows its own fence's row N, and the later markers, tables and a repeated section heading above them are removed. Anything else stays `repeated_marker` and a person merges the fences. |
| `close_fence` | A fence with no end marker gets one directly after its table, when nothing but blank lines follows the last row up to the end of the section. |
| `close_fence_trailing` | A fence with no end marker whose table is followed by page text gets the end marker directly after its last row, so the text that followed becomes visible, when every trailing line is prose (no `|`, no fence marker; a line with a `|` only after the repair model read the tail as prose) and either the page is private (its body is never shown to remote readers, so nothing new is disclosed) or the user approved those exact lines through the hash-bound apply the preview prints. A world-visible page with no approval is `tail_exposure_approval`; a tail the model read as rows, or a marker mention, is `unclosed_ambiguous_tail` and a person closes the fence. |
| `marker_form` | Two-dash takes markers (`<!-- gbrain:takes:begin -->`) directly above a takes table become the three-dash markers. Two-dash facts markers are not a fence and are left alone. |
| `stray_empty_cell` | A row with more cells than its header (with no header: than the narrow layout, or 14 facts cells) loses empty cells, only when exactly one choice of empty cells to remove leaves every checked column (`#`, kind, confidence, visibility, notability, `claim_value`; takes kind, holder, weight) valid. Otherwise the row is `extra_cells` and a person fixes it. |
| `renumber` | A row number that is zero, negative, not a number or a duplicate gets a new number (see [row numbers](#row-numbers)). |
| `column_default` | A required facts column missing from the whole header gets its write default: `confidence` `1.0`, `notability` `medium`, `visibility` `private`. Takes have no defaults; a takes fence with no weight is `weight_missing`. |
| `header_alias` | A header whose every column has a known spelling (see [header spellings](#header-spellings)) becomes the canonical header, and each row's cells move into canonical order unchanged. |
| `enum_synonym` | Facts notability `critical`, `very high`, `highest` → `high`; `very low`, `minor` → `low`; visibility `internal`, `team`, `confidential`, `restricted`, `secret`, `shared` → `private`, and `public` → `world` only on a world-visible page (`private` otherwise); case and spacing variants of a canonical value. Any other word is `enum_unmapped`. |
| `kind_map` | Facts: `proposal`, `suggestion`, `hypothesis` → `idea`; `opinion`, `view`, `insight`, `assessment`, `frame` → `belief`; `promise`, `pledge` → `commitment`; `meeting`, `launch`, `announcement`, `milestone` → `event`; any other word → `fact`, with the word kept in `context` (for example `original kind: partnership`). A facts kind cell longer than three words, or with sentence punctuation, a link or strikethrough, is not read as a kind: it is `claim_split`, usually the end of a claim an unescaped `|` cut in two. Takes: `assessment`, `recommendation`, `strategic position`, `opinion`, `view` → `take`; `prediction`, `forecast` → `bet`; `guess`, `intuition` → `hunch`; any other word is `takes_kind_unsupported`, because gbrain never chooses a takes kind. |
| `holder_alias` | Takes holder `system`, `assistant`, `ai`, `agent`, `gbrain`, `model` (any case) → `brain`. |
| `confidence_format` | A percent or a number with stray spaces in `confidence` or `weight` becomes a decimal: `85%` → `0.85`, `0. 8` → `0.8`. A number outside 0 to 1 is `confidence_out_of_range`. |
| `holder_verified` | Tier 2, not Tier 1: a takes holder written as a name becomes the one `people/` or `companies/` page it resolves to exactly. On a world-visible page a private page never matches. Anything less certain stays `holder_unresolved`. |

<a id="header-spellings"></a>
### Header spellings

Header cells are compared case-insensitively, with spaces, `_` and `-` treated alike. A column not listed accepts only its own name.

| facts column | Also accepted in a header |
| --- | --- |
| `#` | `row`, `row #`, `row num`, `row number`, `no`, `no.`, `num` |
| `claim` | `fact`, `statement` |
| `kind` | `type`, `category` |
| `confidence` | `conf`, `weight` |
| `visibility` | `vis` |
| `notability` | `importance` |
| `valid_from` | `valid from`, `since`, `date`, `from` |
| `valid_until` | `valid until`, `until`, `to` |
| `source` | `src` |
| `context` | `notes`, `note` |
| `claim_metric` | `claim metric`, `metric` |
| `claim_value` | `claim value`, `value` |
| `claim_unit` | `claim unit`, `unit` |
| `claim_period` | `claim period`, `period` |

| takes column | Also accepted in a header |
| --- | --- |
| `#` | `row`, `row #`, `row num`, `row number`, `no`, `no.`, `num` |
| `claim` | `take`, `statement` |
| `kind` | `type` |
| `who` | `holder` |
| `weight` | `confidence`, `conf` |
| `since` | `date`, `as of` |
| `source` | `src` |

<a id="never-guessed"></a>
## What gbrain never guesses

A problem the rules above cannot fix exactly is held or refused with a reason. The reason says which tier clears it:

- **llm** (Tier 3, the repair model rewrites only the named rows, or answers HOLD when a row has two readings): [`header_unmapped`](write-refusals.md#fence-header_unmapped), [`no_header`](write-refusals.md#fence-no_header), [`row_before_header`](write-refusals.md#fence-row_before_header), [`short_row`](write-refusals.md#fence-short_row), [`unclosed_trailing_content`](write-refusals.md#fence-unclosed_trailing_content).
- **resolver** (Tier 2, verified holder lookup, free): [`holder_unresolved`](write-refusals.md#fence-holder_unresolved).
- **manual** (a person edits the fence; gbrain never guesses): [`extra_cells`](write-refusals.md#fence-extra_cells), [`claim_split`](write-refusals.md#fence-claim_split), [`missing_begin`](write-refusals.md#fence-missing_begin), [`split_rows`](write-refusals.md#fence-split_rows), [`marker_near_miss`](write-refusals.md#fence-marker_near_miss), [`repeated_marker`](write-refusals.md#fence-repeated_marker), [`takes_in_facts`](write-refusals.md#fence-takes_in_facts), [`superseded_ambiguous`](write-refusals.md#fence-superseded_ambiguous), [`enum_unmapped`](write-refusals.md#fence-enum_unmapped), [`weight_missing`](write-refusals.md#fence-weight_missing), [`holder_missing`](write-refusals.md#fence-holder_missing), [`confidence_out_of_range`](write-refusals.md#fence-confidence_out_of_range), [`claim_value_invalid`](write-refusals.md#fence-claim_value_invalid), [`takes_kind_unsupported`](write-refusals.md#fence-takes_kind_unsupported).

<a id="gates"></a>
### Gates every repair passes

No tier writes a fence until all of these hold, and the result is one the rules above would leave unchanged. A Tier 3 proposal that fails one stays held with the gate and rows named.

| Gate | Reason when it fails | What must hold |
| --- | --- | --- |
| (a) | [`still_invalid`](write-refusals.md#fence-still_invalid) | The result parses with no warning: no repeated marker, unique row numbers. |
| (b) | [`claim_changed`](write-refusals.md#fence-claim_changed) | Every claim cell is unchanged (struck claims included). |
| (c) | [`row_number_changed`](write-refusals.md#fence-row_number_changed) | Every row number that was valid and unique still names the same claim. |
| (d) | [`visibility_loosened`](write-refusals.md#fence-visibility_loosened) | No row becomes more visible: `private` never turns `world`. |
| (e) | [`row_count_changed`](write-refusals.md#fence-row_count_changed) | No row is added or dropped, and every row of the fence stays inside it; under `merge_fences` the only rows dropped are the exact duplicates its mapping names. |
| (f) | [`cell_changed`](write-refusals.md#fence-cell_changed) | A cell valid in its column keeps its text; a misaligned cell may only move, and text changes only through a named rule. |
| (g) | [`protection_loosened`](write-refusals.md#fence-protection_loosened) | Text the privacy boundary hid before the repair stays hidden after it, except the trailing lines a `close_fence_trailing` fix shows (admitted only on a private page or under the user's approval). |
<!-- END GENERATED fence-format -->
