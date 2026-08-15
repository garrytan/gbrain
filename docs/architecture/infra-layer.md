# GBrain Infrastructure Layer (orientation pointer)

The shared foundation that all skills, recipes, and integrations build on.
This page is a router — the detailed, current-state references live in the
docs below (this file once carried its own copies of the pipeline and schema;
those rotted, so each concept now has exactly one home).

## Where things live

| Topic | Home |
|---|---|
| Ingest pipeline (file resolution → frontmatter parse → content-hash idempotency → chunking → embedding → atomic write) | per-file entries in [`KEY_FILES.md`](./KEY_FILES.md): `src/core/import-file.ts`, `src/core/sync.ts`, `src/core/markdown.ts`, `src/core/embedding.ts`, `src/core/chunkers/*` |
| Chunking strategies (recursive / semantic / LLM-guided) | `src/core/chunkers/{recursive,semantic,llm}.ts` entries in [`KEY_FILES.md`](./KEY_FILES.md) |
| Search pipeline (hybrid RRF, graph, reranker, autocut, dedup, budgets) | [`RETRIEVAL.md`](./RETRIEVAL.md) |
| Search modes + cost knobs | `docs/guides/search-modes.md` + the CLAUDE.md Search Mode table |
| Per-file index of `src/` (what each file does + its invariants) | [`KEY_FILES.md`](./KEY_FILES.md) |
| Schema DDL | the `MIGRATIONS` array in `src/core/migrate.ts` (source of truth) + `src/schema.sql`; per-table classification in [`system-of-record.md`](./system-of-record.md) |
| Engines (PGLite vs Postgres, parity rules) | `docs/ENGINES.md` + the engine entries in [`KEY_FILES.md`](./KEY_FILES.md) |
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
