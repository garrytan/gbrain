# Windowed reads: large pages over MCP

A page can be far larger than one tool result can carry. A conversation
export or a long log of 2 MB is about 500k tokens, and Claude Code cuts a tool
result at about 25k tokens. From this release, `get_page`, `fetch` and evidence
delivery read a large page in windows: bounded slices addressed in UTF-8 bytes
and lines, each one a slice of the same read projection a whole-page read
returns. Nothing is cut silently: every partial response says it is partial,
and the whole page stays reachable.

This guide covers who gets what, the parameters, and the four refusals.

## Who gets a window

| Caller | `get_page` with no body mode | Large page (over 256 KB) |
| --- | --- | --- |
| Trusted local CLI (`gbrain get`) | Whole page | Whole page, any size |
| gbrain's thin client (`X-Gbrain-Client` header) | Whole page | Whole page while it fits the connection; otherwise the CLI pages the round-trip markdown to its end and checks its sha256, or fails without printing |
| Any other MCP client | `auto` | Outline plus a first window; never `compiled_truth`, `timeline` or `content` |

The inline size is `mcp.inline_body_bytes` (default 256 KB). Hosts advertise the
contract in `get_brain_identity` as `capabilities: ["large_pages_v1"]`.

## get_page body modes

| Parameter | Meaning |
| --- | --- |
| `body: "auto"` | Whole page up to the inline size, else outline plus a first window (`auto_reason: "over_inline_bytes"`). |
| `body: "full"` | Whole page, up to the connection's egress cap; `include_content: true` means the same. |
| `body: "none"` | Revision, size, total lines and chunk counts. Use it for `edit_page`'s `expected_revision`. |
| `body: "outline"` | Headings (or blocks for pages with fewer than two headings) with line and byte ranges and date ranges; page it with `outline_from`. |
| `body: "window"` | One window. Choose it with exactly one selector below; with none, the window starts at the top. |
| `lines: {from, count}` | 1-based lines. |
| `bytes: {offset, length}` | UTF-8 bytes of the requested view (`size.total_bytes`), snapped back to a line start. |
| `around_chunk_id: N` | The text around a search hit's chunk, `context_lines` either side (default 20). |
| `cursor: "gpw1.…"` | `next_cursor` from the previous window. |
| `max_bytes` | Window size (default 40,000, at most 1 MiB, and always inside the connection's cap). |
| `view: "markdown"` | Page the round-trip markdown (`include_content`'s `content`) instead of the read text; `size.sha256` verifies the joined pages. |

Passing two selectors, a selector with `body: "outline"`, or `include_content`
with a partial mode is `invalid_params` with an example. A window response
carries `window {text, byte_start, byte_end, line_start, line_end}`,
`size {total_bytes, total_lines}`, `truncated`, and when more follows
`next_cursor` plus `next`, the exact `get_page` call that reads on. The starter
MCP surface advertises none of the window parameters (its tool list has a fixed
size budget); it accepts all of them, so following `next` or a refusal's fix works
there too. A line longer than the window is cut on a character boundary and
marked `forced_cut`.

### Window coordinates

`bytes.offset`, `byte_start` and `byte_end` count UTF-8 bytes of the view the
response reads, the read text (`view: "read"`, the default) or the round-trip
markdown (`view: "markdown"`), and `size.total_bytes` is that view's length.
On a page stored in segments, `size.body_bytes` is the stored body's size,
which is not a coordinate: the read text drops what remote readers never see
(Takes and non-world Facts fences, for example) and adds the low-tier rows
block, so it can be shorter or longer than `body_bytes`. To read the last N
bytes, take `size.total_bytes` from `body: "none"` in the same view and ask for
`bytes: {offset: total_bytes - N, length: N}`. An offset at or past
`size.total_bytes` returns an empty window (`byte_start` = `byte_end` =
`total_bytes`, no `next_cursor`), the end of the page rather than missing
content; inline and segmented pages answer it the same way.

`around_chunk_id` uses the chunk's recorded position (`anchor: "stored_span"`).
A chunk written before positions were recorded is located only when its text is
unique on the page (`anchor: "located"`); otherwise the response is the chunk
itself with no surrounding text (`anchor: "chunk_only"`), never a guessed
neighborhood.

## fetch and evidence delivery

`fetch` returns a page over the inline size as the window around the searched
chunk: a search result id past the page's first chunk names that chunk.
`metadata.total_bytes`, `metadata.window` and `metadata.next_id` describe the
window; fetch `next_id` to read on. A chunk id from before a re-chunk falls back
to the first window (`metadata.anchor: "chunk_not_current"`), and an old
continuation reads on from the same byte offset (`"cursor_rebased"`).

Evidence delivery (`return_unit` on search, query and `assemble_evidence`)
never assembles a page over the inline size whole: a `page` unit becomes the
window around the hits, with `delivered.fallback_reason: "page_over_inline_bytes"`.
A truncated search snippet past the first chunk points at
`get_page <slug> around_chunk_id=<id>`.

On a page stored in segments, an evidence block is read around its hits only:
each hit's window (its neighbor chunks, or its segment for `section`) comes
from the same per-segment read projection as a `get_page` window, so it costs
the windows, not the page. Hits far apart come back as one block of separate
windows joined by `[…]`. Search keeps up to two hits per region of such a page
(hits more than 1 MiB apart are separate regions) and at most six per page; an
inline page keeps two.

## Privacy

Windows, outlines and snippets for remote callers are slices of the read
projection: withdrawn facts overlaid, Takes and non-world Facts fences removed,
credentials projected. A window that starts inside a protected fence, balanced
or not, holds none of it, and an outline never names a heading inside one.

## Egress caps

Every MCP result is measured as the complete encoded JSON-RPC frame, notices and
escaping included. Defaults: 4 MiB on stdio (`mcp.max_result_bytes_stdio`),
1 MiB on HTTP (`mcp.max_result_bytes_http`); a configured value is clamped to
256 KiB–9 MiB. Windows shrink until their frame fits.

## page_too_large_for_inline

`get_page` with `body: "full"` (or `include_content`, or gbrain's thin client
naming no mode) asked for a page whose encoded result is over the connection's
cap. gbrain's thin client also gets it for a page stored in segments, its
signal to page the round-trip markdown; any other caller gets
`page_body_segmented` for such a page. Nothing was returned or cut. Read `body: "outline"`, then windows; edit with
`edit_page` using the revision from `body: "none"`. An older gbrain CLI gets this
refusal instead of a partial page: upgrade it (`gbrain upgrade`).

## page_body_segmented

The page's body is stored in segments (a page over 1 MiB written while
`pages.segmented_storage` is on, the default; see
[segmented page storage](memory-boundaries.md#segmented-page-storage)), and the command or tool that hit it reads or
writes the whole body as one string. It stopped before reading or changing
anything, so the page is intact, and retrying refuses the same way. Read the
page in pieces: `get_page` `body: "auto"` (`gbrain get --body auto <slug>`)
returns its outline and first window, then `body: "window"` reads on;
`gbrain get <slug>` with no `--body` prints it whole, streamed. Queue work (fact reconcile, the facts backstop, link and mention
passes, effect scans) skips a segmented page with this code as its logged
reason instead of stopping. Life Chronicle extraction, `edit_page` and the
derived-link passes (a trusted page write's links, the managed stale-links
pass, post-batch auto-link) read a segmented page up to 24 MiB as one string;
the extraction and link passes skip a larger one with this code.

`get_page` `body: "full"` (and `include_content` / `content_only`) on such a
page refuses with this code for trusted local and MCP callers alike; a trusted
local caller's default body mode is `full`, so a plain local read of a page
over 1 MiB refuses too, and the fix reads it with `body: "auto"`.
`grammar_diagnostics` on such a page answers the read with
`line_grammar: {state: "skipped", reason: "page_body_segmented"}`. The
`entity` card's `identity_excerpt` of such a page is cut from its first
64 KiB of compiled truth. `remember` against an entity page stored in
segments up to 24 MiB reads it back whole and adds the fact row; over 24 MiB
it refuses with this code (wire `error: invalid_params`, not retryable) and a
fix that saves the claim without an entity (`infer_entity: false`), whether
the entity was named or inferred from the fact.

Semantic writes work on such a page. `add_tag` and `remove_tag` change the
tag at any size without rewriting the body: the tag rows, `content_hash` and
a version change, and a page backed by a file gets the new frontmatter in that
file with its body bytes unchanged. `add_timeline_entry`, the `takes_*`
writes, the facts fence write of `extract_facts`, `gbrain core add` /
`remove` / `diff` and `gbrain sources reconcile` read a page up to 24 MiB
back whole and write it as a normal put, with the result an inline page with
the same body gets; over 24 MiB they refuse with this code, and the message
names the 24 MiB limit.

## page_body_rows_unreadable

A read of a segmented page found manifest rows that do not cover the page's
stored body: they must run from byte 0 to the page's `body_bytes` (a retained
version's own `body_bytes` for an older generation) without a gap. The usual
cause is a database role that can read the page row but not its segment rows
(a row-level security policy or grant on `pages` only); a damaged database is
the other. gbrain returns nothing rather than an empty or truncated page, and
every reader that produces the body checks it: `get_page`, `fetch`, export,
backup and restore file writes, body digests, fence rewrites and purges, and
timeline extraction. An export with such a page fails instead of writing a
short file. The brain host's operator gives the reading role the same
access to `page_body_manifest` and `page_segment_texts` it has to `pages`;
`gbrain doctor --json` checks the segment tables.

## page_projection_stale

A read of a segmented page reached a segment whose stored projection metadata
(its protected regions, written when the segment was stored) cannot be used:
it was written by another segmenter version or the text does not match its
hash, and the parser state carried with the segment is missing or of another
version. A trusted body read also refuses when a facts fence block crosses a
forced segment cut while the source has withdrawals. gbrain returns nothing for
that segment rather than text it cannot sanitize. Rewrite the page body (import
or sync its file again), which segments it with this gbrain version, then read
it again; other windows and the outline still work.

## page_shrink_refused

A remote `put_page` would replace a page over the inline size with content under
half its size. That is most often a window sent back as the page, which would
delete the unread rest, so nothing was written. Change part of the page with
`edit_page`. When the smaller content really is the intended complete page,
resend it with `allow_shrink: true` and the page's `expected_revision`. Replacing
a page over the inline size always needs `expected_revision`; `force` does not
stand in for it.

## result_too_large

The tool's result, measured as the final encoded frame, is over this
connection's cap, so it was replaced by this error; nothing was cut. Ask for less
in one call: a window, a page of rows, or metadata only. The error's `detail`
names the measured size, the cap and the config key that sets it.

## revision_changed

The page changed after the cursor or chunk id was issued, so that position no
longer names the same text. The fix reads on from the same byte offset at the
current revision; or start again from `body: "outline"`, or search again for a
current chunk id.
