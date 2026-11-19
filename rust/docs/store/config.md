# The brain store: Config

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the config entry `version`, set to the `schemaVersion` given to `open`
(`getConfig('version')` equals `LATEST_SCHEMA_VERSION`, 319 today). When `open` also gets
`writeGateDetectorVersion` (the engine passes `WRITE_GATE_DETECTOR_VERSION`), the fresh brain records
`write_gate.scan_baseline` the way migration v227 does on an empty SQL brain: every table at `0`, so
doctor `trust_scan` counts no row written later. A brain made before this has no baseline and counts
its unscanned rows from the start. Values are strings and keys cannot contain NUL.

`open` also writes the caller's `embeddingModel`, `embeddingDimensions` and `chunkStrategy` (each when
given) as the config entries `embedding_model`, `embedding_dimensions` and `chunk_strategy`, for a fresh
brain only, as PGLite's `initSchema` seeds them (`src/schema.sql`). A reopened brain keeps its own
entries. The TypeScript engine passes the same identity PGLite seeds (`seedEmbeddingIdentity` in
`src/core/rust-engine/store.ts`: the schema settings, then the gateway, then the defaults), so a chunk
written with no model of its own carries the brain's model, as on PGLite. In Rust the rows come from
`OpenOptions::initial_config`; an empty key or the key `version` is `invalid_argument`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getConfig(key)` | `string \| null` | `getConfig` |
| `brain.setConfig(key, value)` | `null`; an upsert | `setConfig` |
| `brain.unsetConfig(key)` | rows removed, `0` or `1` | `unsetConfig` |
| `brain.listConfigKeys(prefix)` | sorted `string[]`; the prefix is literal (`%` and `_` are plain characters) | `listConfigKeys` |
| `brain.getAllConfig()` | `{ [key]: value }` | `getAllConfig` |
