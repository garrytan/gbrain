# The brain store: Config

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the config entry `version`, set to the `schemaVersion` given to `open`
(`getConfig('version')` equals `LATEST_SCHEMA_VERSION`, 331 today; the crate's `DEFAULT_SCHEMA_VERSION`, 319, is only the default its own tests open with, and the binding passes the live value). A fresh brain records
`write_gate.scan_baseline` the way migration v227 does on an empty SQL brain (the `jsonb` text Postgres
prints): every table at `0`, under the `writeGateDetectorVersion` that `open` gets (the engine passes
`WRITE_GATE_DETECTOR_VERSION`; `2` when none is given), so doctor `trust_scan` counts no row written later. Values are strings and keys cannot contain NUL.

The engine's `initSchema` (`src/core/rust-engine/store-members/init-schema.ts`) then writes the
`embedding_model` and `embedding_dimensions` entries PGLite's schema seeds, each only when the brain
has none: the stored embedding identity when there is one, else the gateway's model and width, else
the install defaults (`voyage:voyage-4`, 1024). A stored width with no known model writes no model.

`open` also writes the caller's `embeddingModel`, `embeddingDimensions` and `chunkStrategy` (each when
given) as the config entries `embedding_model`, `embedding_dimensions` and `chunk_strategy`, for a fresh
brain only, as PGLite's `initSchema` seeds them (`src/schema.sql`). A reopened brain keeps its own
entries. The TypeScript engine passes the same identity PGLite seeds (`seedEmbeddingIdentity` in
`src/core/rust-engine/store.ts`: the schema settings, then the gateway, then the defaults), so a chunk
written with no model of its own carries the brain's model, as on PGLite. In Rust the rows come from
`OpenOptions::initial_config`; an empty key or the key `version` is `invalid_argument`.
The engine's `initSchema` (`src/core/rust-engine/store-members/init-schema.ts`) then writes the
`embedding_model` and `embedding_dimensions` entries PGLite's schema seeds, each only when the brain
has none: the stored embedding identity when there is one, else the gateway's model and width, else
the install defaults (`voyage:voyage-4`, 1024). A stored width with no known model writes no model.


| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getConfig(key)` | `string \| null` | `getConfig` |
| `brain.setConfig(key, value)` | `null`; an upsert | `setConfig` |
| `brain.unsetConfig(key)` | rows removed, `0` or `1` | `unsetConfig` |
| `brain.listConfigKeys(prefix)` | sorted `string[]`; the prefix is literal (`%` and `_` are plain characters) | `listConfigKeys` |
| `brain.getAllConfig()` | `{ [key]: value }` | `getAllConfig` |

The engine's `readStoredConfigValue(key)` (`src/core/rust-engine/store-members/config.ts`, the `sync.admission` read of
`readSyncAdmission`) is `brain.getConfig(key)`: the stored row, `null` without one.

## Dream map rows

The dream breaker and the write deferrals keep a JSON map in one config row each (`src/core/engine-sql/dream-cycle.ts`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.ensureDreamMapConfigRow({ key })` | `null`; adds the row holding `{}` only when the key has none | `ensureDreamMapConfigRow` |
| `brain.lockDreamMapConfigRow({ key })` | `{ value, now }` (`now` is `YYYY-MM-DDTHH:MM:SS.mmmZ`) or `null`; no row lock, the store has one writer | `lockDreamMapConfigRow` |
| `brain.writeDreamMapConfigRow({ key, value })` | `null`; updates a row that exists, never adds one | `writeDreamMapConfigRow` |
| `brain.recordDreamBreakerReset({ resetsKey, baseKey })` | `null`; keeps the other entries dated within 24 hours, sets `baseKey` to now plus one millisecond, writes jsonb text; a value that is not a JSON object reads as `{}` | `recordDreamBreakerReset` |

A kept entry that starts like a date but is not an ISO instant ends in `invalid_argument`, as the `::timestamptz` cast does, and the row is left as it was.
