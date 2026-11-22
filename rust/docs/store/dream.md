# The brain store: Dream verdicts

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A dream verdict caches the triage judgment for one file version, keyed by `(file_path, content_hash)`
under key tag `Y`. A verdict lives 30 days from the write that stored it (`DREAM_VERDICT_TTL_SECONDS`).
It ports `src/core/engine-sql/dream.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getDreamVerdict(filePath, contentHash)` | `{ worth_processing, reasons, judged_at, score, content_type, segments, entities, model, triage_version }` or `null`. `null` also when the verdict expired (`expires_at <= now`). Missing lists read back as `[]`; `judged_at` is microsecond ISO text | `getDreamVerdict` |
| `brain.putDreamVerdict(filePath, contentHash, verdict)` | `null`; an upsert that replaces every field and sets `judged_at = now`, `expires_at = now + 30 days`. A missing `worth_processing` is `constraint_violation`; a non-integral or out-of-int4 `triage_version` and U+0000 in any text or JSON value are `invalid_argument`, and nothing is written | `putDreamVerdict` |
| `brain.sweepDreamVerdicts()` | the number of rows deleted, those with `expires_at <= now` | `sweepDreamVerdicts` |

JSON values (`reasons`, `segments`, `entities`) read back in jsonb key order: object keys sort by byte
length, then by bytes, at every depth. The TypeScript member applies `wellFormedJson` before the call,
so a lone surrogate becomes U+FFFD as it does on Postgres.
