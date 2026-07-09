---
name: migrating-oracle-to-postgres-stored-procedures
description: 'Migrates Oracle PL/SQL stored procedures to PostgreSQL PL/pgSQL. Translates Oracle-specific syntax, preserves method signatures and type-anchored parameters, leverages orafce where appropriate, and applies COLLATE "C" for Oracle-compatible text sorting. Use when converting Oracle stored procedures or functions to PostgreSQL equivalents during a database migration.'
triggers:
  - "migrating-oracle-to-postgres-stored-procedures"
  - "migrating oracle to postgres stored procedures"
  - "awesome copilot migrating oracle to postgres stored procedures"
---

# Migrating Stored Procedures from Oracle to PostgreSQL

Translate Oracle PL/SQL stored procedures and functions to PostgreSQL PL/pgSQL equivalents.

## Workflow

```
Progress:
- [ ] Step 1: Read the Oracle source procedure
- [ ] Step 2: Translate to PostgreSQL PL/pgSQL
- [ ] Step 3: Write the migrated procedure to Postgres output directory
```

**Step 1: Read the Oracle source procedure**

Read the Oracle stored procedure from `.github/oracle-to-postgres-migration/DDL/Oracle/Procedures and Functions/`. Consult the Oracle table/view definitions at `.github/oracle-to-postgres-migration/DDL/Oracle/Tables and Views/` for type resolution.

**Step 2: Translate to PostgreSQL PL/pgSQL**

Apply these translation rules:

- Translate all Oracle-specific syntax to PostgreSQL equivalents.
- Preserve original functionality and control flow logic.
- Keep type-anchored input parameters (e.g., `PARAM_NAME IN table_name.column_name%TYPE`).
- Use explicit types (`NUMERIC`, `VARCHAR`, `INTEGER`) for output parameters passed to other procedures — do not type-anchor these.
- Do not alter method signatures.
- Do not prefix object names with schema names unless already present in the Oracle source.
- Leave exception handling and rollback logic unchanged.
- Do not generate `COMMENT` or `GRANT` statements.
- Use `COLLATE "C"` when ordering by text fields for Oracle-compatible sorting.
- Leverage the `orafce` extension when it improves clarity or fidelity.

Consult the PostgreSQL table/view definitions at `.github/oracle-to-postgres-migration/DDL/Postgres/Tables and Views/` for target schema details.

**Step 3: Write the migrated procedure to Postgres output directory**

Place each migrated procedure in its own file under `.github/oracle-to-postgres-migration/DDL/Postgres/Procedures and Functions/{PACKAGE_NAME_IF_APPLICABLE}/`. One procedure per file.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `migrating-oracle-to-postgres-stored-procedures`: Migrates Oracle PL/SQL stored procedures to PostgreSQL PL/pgSQL. Translates Oracle-specific syntax, preserves method signatures and type-anchored parameters, leverages orafce where appropriate, and applies COLLATE
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
