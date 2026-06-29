# Self-Service Analytics Hardening Implementation Plan

Date: 2026-06-29
Spec: `docs/superpowers/specs/2026-06-28-self-service-analytics-hardening-design.md`

## Goal

Implement the first production slice of the self-service analytics hardening
spec: manifest-backed agent docs, MCP docs resources, trust footers for
retrieval evidence, resolver metadata indexing, and a durable context eval /
correction ledger.

## Constraints

- Work in the existing spec worktree.
- Keep changes scoped to the spec.
- Run targeted tests while developing.
- Open the PR before running the full test suite.
- After PR creation, run the full suite and an adversarial subagent review.

## Steps

1. Add a skill surface manifest service and contract tests.
   - Manifest packaged docs with stable IDs, relative paths, hashes, and
     loadability flags.
   - Add stale-flow checks for the selected agent guides.
   - Expose a CLI JSON path for the manifest.

2. Expose manifest-backed MCP resources.
   - Implement `resources/list` and `resources/read`.
   - Keep initialize instructions compact.
   - Return structured errors for unknown docs resource URIs.
   - Update HTTP / MCP transport tests.

3. Add trust footer contracts.
   - Add `AnswerTrustFooter` and bounded `probe_context` types.
   - Attach probe footers to `retrieve_context`.
   - Attach canonical evidence footers to `read_context`.
   - Include trace IDs when traces are persisted.

4. Add resolver metadata to note manifests.
   - Parse resolver frontmatter fields into a typed manifest column.
   - Include resolver metadata in schema, migrations, SQLite, PGLite, and
     Postgres storage.
   - Add manifest tests for typed metadata and hash sensitivity.

5. Add context eval and correction ledger.
   - Add durable run, assertion, and correction types.
   - Add engine APIs and SQL-backed implementations.
   - Add `mbrain eval context` and `mbrain eval correction record`.
   - Support fixture execution, comparison JSON, and trace-linked corrections.

6. Wire operator summaries.
   - Add lightweight doctor / memory-report JSON summary fields where the
     existing surfaces can report footer/resource/eval readiness.

7. Verify and publish.
   - Run essential targeted tests and typecheck before commit.
   - Commit and push.
   - Create a ready PR.
   - Run full tests after PR creation.
   - Run adversarial subagent review, address findings, then merge.
