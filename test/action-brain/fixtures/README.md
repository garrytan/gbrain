# Action Brain Gold-Set Fixtures

- Checked-in CI fixture: `gold-set.jsonl` (13-message deterministic set).
- Checked-in draft-quality CI fixture: `draft-gold-set.jsonl` (15+ deterministic draft cases).
- Private expanded corpus: set `ACTION_BRAIN_PRIVATE_GOLD_SET_PATH` to a local JSONL file with the same schema and at least 50 rows.
- Private expanded draft corpus: set `ACTION_BRAIN_PRIVATE_DRAFT_GOLD_SET_PATH` to a local JSONL file with the same schema and at least 50 rows.

## JSONL row schema

Each line is a JSON object with:

- `id`: string
- `message`: `{ MsgID, ChatName, SenderName, Timestamp, Text }`
- `expectedCommitments`: `[{ who, action, type }]` where `type` is `owed_by_me` or `waiting_on`
- `baselineCommitments`: `[{ who, owes_what, type, confidence?, source_message_id? }]`

`baselineCommitments` are frozen deterministic model outputs fed through extractor tests via a stubbed client, so CI evaluates recall against extractor-normalized predictions without external API calls.

## Draft JSONL row schema

Each line is a JSON object with:

- `id`: string
- `action_item`: object (must include `title`)
- `gbrain_pages`: `[{ slug, compiled_truth }]`
- `thread`: `[{ sender, ts, text }]`
- `expected`: `{ must_include_any, must_not_include_any, max_chars, tone }`
- `deterministic_draft`: string

`deterministic_draft` is the frozen model output used by
`test/action-brain/draft-gold-set.test.ts` to keep CI deterministic while still
validating structural quality gates.
