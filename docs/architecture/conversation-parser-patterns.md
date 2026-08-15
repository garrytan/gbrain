# Conversation parser patterns

The conversation parser turns exported chat and meeting transcripts into a
common message stream without requiring an LLM call for known formats. This
document describes the built-in pattern contract and the checks required when
adding or changing a format.

## Data flow

`parseConversation` uses this sequence:

1. Resolve the page date and timezone context.
2. Score every enabled built-in and user pattern against the first ten
   non-blank lines.
3. Re-score the full body when the head score is inconclusive, or when a broad
   pattern explicitly requires full-body scoring.
4. Reject the winner when its acceptance score is below the false-positive
   floor.
5. Apply the winning pattern to every line and attach continuation lines to the
   preceding message.
6. Optionally run LLM polish or fallback when those features are enabled.

Pattern order is only a tie-breaker. A new regex must be structurally distinct
from neighboring formats; moving it earlier in the registry is not a valid
non-shadowing strategy.

## Built-in pattern contract

Every `PatternEntry` in `builtins.ts` declares:

- A stable, kebab-case `id`.
- A hand-vetted line regex and explicit capture-group indexes.
- Where the date comes from and how the time is represented.
- A timezone policy.
- Whether the format supports multi-line message bodies.
- Positive and negative samples that run during module initialization.
- A documentation pointer describing the source format.

The registry refuses to load when a positive sample stops matching, a negative
sample starts matching, or a capture map becomes invalid. This catches local
regex mistakes before extraction can silently produce empty conversations.

### Date and timezone rules

Formats with an inline date should capture it from each message. Time-only
formats use an explicit caller fallback first, then the page frontmatter date,
then the page effective date. If none is available, the parser uses
`1970-01-01` so the missing date remains visible instead of inventing a current
date.

Time-only formats normally use `utc_assumed_with_warn`. The parser constructs a
UTC timestamp and returns a timezone warning when the page does not provide a
timezone. A new pattern should not imply local-time precision that the source
format does not contain.

### Multi-line messages

An anchor regex identifies the first line of a message. Subsequent non-anchor
lines are appended to that message until another anchor appears. Set
`multi_line: true` when continuation content is part of the documented format,
such as Markdown bullets, blockquotes, or an exported message body on the next
line.

Tests for a multi-line format should assert the complete message text, including
newlines. A message-count assertion alone will not detect lost bullets or a
continuation attached to the wrong speaker.

### Scoring and false positives

The score compares matched anchors with the pattern's relevant candidate lines.
The first pass uses the head of the page for speed. Low-confidence pages are
re-scored across the full body before the parser accepts a winner.

Multi-line formats may opt into `score_continuations_as_body` when their anchor
grammar is distinctive. Candidate-only scoring activates only after two anchors
match, or when the first non-blank line is an anchor. This evidence threshold
lets a single long message keep its continuation body without turning one stray
anchor in a prose page into a conversation. Candidate anchor lines that fail the
full regex still lower the score. Other patterns continue to use all non-blank
lines in their density score.

Use `score_full_body: true` for a broad grammar that also occurs in ordinary
prose. For example, `**Label:** text` can be either a transcript line or a bold
label in meeting notes. Narrow formats with a timestamp and a distinctive
separator generally do not need this override.

`quick_reject` is a performance hint, not an acceptance rule. It should cheaply
exclude obviously unrelated lines while admitting every string accepted by the
main regex.

## Normalized Slack Markdown

The `bold-time-dash` pattern parses message anchors shaped like:

```text
**Alice Example** 09:15 — first message
- supporting detail
**Bob Example** 09:18 — second message
```

Its grammar is:

```text
**speaker** H:MM <dash> text
```

where:

- `H:MM` is a valid 24-hour time from `0:00` through `23:59`.
- `<dash>` may be an em dash (`—`), en dash (`–`), or ASCII hyphen (`-`).
- The date comes from the resolved page date context.
- Continuation lines belong to the preceding message.
- The captured clock value is emitted with `Z`. Timezone metadata suppresses
  the missing-timezone warning but is not currently used for IANA conversion.

The required time and dash distinguish it from all existing bold-speaker
formats:

- `**Speaker** (09:15): text` uses `bold-paren-time`.
- `**Speaker** (9:15 AM): text` uses `bold-paren-time-12h`.
- `**Speaker:** text` uses `bold-name-no-time`.
- `**Speaker** (2026-04-09 9:15 AM): text` uses `imessage-slack`.

Keeping these examples in both `test_negative` and parser regression tests makes
the non-shadowing contract executable.

## Adding a built-in format

1. Collect multiple anonymized examples, including separator and timestamp
   variants that occur in the same export family.
2. Choose the narrowest grammar that represents the format. Constrain numeric
   fields such as hours and minutes when possible.
3. Add at least two positive module-load samples and negative samples for every
   neighboring pattern that could plausibly overlap.
4. Add parser tests that verify speakers, timestamps, text, continuation
   handling, and non-shadowing behavior.
5. Add a dedicated JSONL fixture and include the same cases in
   `test/fixtures/conversation-formats/all.jsonl`.
6. Run the focused parser tests and the fixture evaluator.
7. Run the repository verification and full test suites before submission.
8. Update `docs/architecture/KEY_FILES.md` when the registry count or supported
   format inventory changes.

Use generic fixture identities such as `Alice Example`, `Bob Example`, and
`Summary Bot`. Never copy real transcript names or private content into source,
tests, documentation, commits, or pull-request descriptions.
