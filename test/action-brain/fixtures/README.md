# Action Brain Gold-Set Fixtures

- Checked-in CI fixture: `gold-set.jsonl` (13-message deterministic set).
- Private expanded corpus: set `ACTION_BRAIN_PRIVATE_GOLD_SET_PATH` to a local JSONL file with the same schema and at least 50 rows.

## JSONL row schema

Each line is a JSON object with:

- `id`: string
- `message`: `{ MsgID, ChatName, SenderName, Timestamp, Text }`
- `expectedCommitments`: `[{ who, action, type }]` where `type` is `owed_by_me` or `waiting_on`
- `baselineCommitments`: `[{ who, owes_what, type, confidence?, source_message_id? }]`

`baselineCommitments` are frozen deterministic model outputs fed through extractor tests via a stubbed client, so CI evaluates recall against extractor-normalized predictions without external API calls.
