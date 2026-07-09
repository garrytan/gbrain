---
name: planning-oracle-to-postgres-migration-integration-testing
description: 'Creates an integration testing plan for .NET data access artifacts during Oracle-to-PostgreSQL database migrations. Analyzes a single project to identify repositories, DAOs, and service layers that interact with the database, then produces a structured testing plan. Use when planning integration test coverage for a migrated project, identifying which data access methods need tests, or preparing for Oracle-to-PostgreSQL migration validation.'
triggers:
  - "planning-oracle-to-postgres-migration-integration-testing"
  - "planning oracle to postgres migration integration testing"
  - "awesome copilot planning oracle to postgres migration integration testing"
---

# Planning Integration Testing for Oracle-to-PostgreSQL Migration

Analyze a single target project to identify data access artifacts that require integration testing, then produce a structured, actionable testing plan.

## Workflow

```
Progress:
- [ ] Step 1: Identify data access artifacts
- [ ] Step 2: Classify testing priorities
- [ ] Step 3: Write the testing plan
```

**Step 1: Identify data access artifacts**

Scope to the target project only. Find classes and methods that interact directly with the database — repositories, DAOs, stored procedure callers, service layers performing CRUD operations.

**Step 2: Classify testing priorities**

Rank artifacts by migration risk. Prioritize methods that use Oracle-specific features (refcursors, `TO_CHAR`, implicit type coercion, `NO_DATA_FOUND`) over simple CRUD.

**Step 3: Write the testing plan**

Write a markdown plan covering:
- List of testable artifacts with method signatures
- Recommended test cases per artifact
- Seed data requirements
- Known Oracle→PostgreSQL behavioral differences to validate

## Output

Write the plan to: `.github/oracle-to-postgres-migration/Reports/{TARGET_PROJECT} Integration Testing Plan.md`

## Key Constraints

- **Single project scope** — only plan tests for artifacts within the target project.
- **Database interactions only** — skip business logic that does not touch the database.
- **Oracle is the golden source** — tests should capture Oracle's expected behavior for comparison against PostgreSQL.
- **No multi-connection harnessing** — migrated applications are copied and renamed (e.g., `MyApp.Postgres`), so each instance targets one database.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `planning-oracle-to-postgres-migration-integration-testing`: Creates an integration testing plan for .NET data access artifacts during Oracle-to-PostgreSQL database migrations. Analyzes a single project to identify repositories, DAOs, and service layers that interact with the data
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
