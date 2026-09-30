# GBrain Infrastructure Layer (orientation pointer)

The shared foundation that all skills, recipes, and integrations build on.
This page is a router — the detailed, current-state references live in the
docs below, so each concept has exactly one home.

## Where things live

| Topic | Home |
|---|---|
| Ingest pipeline (file resolution → frontmatter parse → content-hash idempotency → chunking → embedding → atomic write) | per-file entries in [`KEY_FILES.md`](./KEY_FILES.md): `src/core/import-file.ts`, `src/core/sync.ts`, `src/core/markdown.ts`, `src/core/embedding.ts`, `src/core/chunkers/*` |
| Chunking strategies (recursive / semantic / LLM-guided) | `src/core/chunkers/{recursive,semantic,llm}.ts` entries in [`KEY_FILES.md`](./KEY_FILES.md) |
| Search pipeline (hybrid RRF, graph, reranker, autocut, dedup, budgets) | [`RETRIEVAL.md`](./RETRIEVAL.md) |
| Search modes + cost knobs | `docs/guides/search-modes.md` + the CLAUDE.md Search Mode table |
| Per-file index of `src/` (what each file does + its invariants) | [`KEY_FILES.md`](./KEY_FILES.md) |
| Schema DDL | `src/schema.sql` + its TS fragment modules (the one hand-edited copy; `bun run build:schema` generates both engine blobs, see [`ENGINES.md`, "Canonical schema sources"](../ENGINES.md#canonical-schema-sources)); schema changes on existing brains are one file each in `src/core/schema-migrations/` (`bun run new:migration <name>`; `src/core/migrate.ts` is the runner); per-table classification in [`system-of-record.md`](./system-of-record.md) |
| Engines (PGLite vs Postgres, parity rules) | `docs/ENGINES.md` + the engine entries in [`KEY_FILES.md`](./KEY_FILES.md) |
| Storage SQL (one implementation per migrated domain) | `src/core/engine-sql/` (domain modules over one `SqlExecutor`, two dialect adapters); the migrated domains are the `migrated` rows of `scripts/engine-sql-baseline.tsv`; see [`ENGINES.md`, "Storage domains and engine-sql"](../ENGINES.md#storage-domains-and-engine-sql) |
| Where a new storage method, migration, doctor check, CLI command, HTTP route or sync phase goes | [`CONTRIBUTING.md`, "Where does my change go?"](../../CONTRIBUTING.md#where-does-my-change-go) |
| Operations contract (CLI + MCP generated from one source) | `src/core/operations.ts` (100+ operations; run `gbrain --tools-json` for the live list) |
| Brains vs sources (which database vs which repo inside it) | [`brains-and-sources.md`](./brains-and-sources.md) |

## The Thin Harness Principle

GBrain is the deterministic layer. Skills and recipes are the latent-space layer.

See [Thin Harness, Fat Skills](../ethos/THIN_HARNESS_FAT_SKILLS.md) for the full
architecture philosophy.

- **GBrain CLI** = thin harness (same input → same output)
- **Skills** (the bundled set routed by `skills/RESOLVER.md`) = fat skills
- **Recipes** (voice-to-brain, email-to-brain) = fat skills that install infrastructure

The agent reads the skill/recipe and uses GBrain's deterministic tools to do the work.
