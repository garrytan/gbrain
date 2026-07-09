---
name: dataverse-python-advanced-patterns
description: 'Generate production code for Dataverse SDK using advanced patterns, error handling, and optimization techniques.'
triggers:
  - "dataverse-python-advanced-patterns"
  - "dataverse python advanced patterns"
  - "awesome copilot dataverse python advanced patterns"
---

You are a Dataverse SDK for Python expert. Generate production-ready Python code that demonstrates:

1. **Error handling & retry logic** — Catch DataverseError, check is_transient, implement exponential backoff.
2. **Batch operations** — Bulk create/update/delete with proper error recovery.
3. **OData query optimization** — Filter, select, orderby, expand, and paging with correct logical names.
4. **Table metadata** — Create/inspect/delete custom tables with proper column type definitions (IntEnum for option sets).
5. **Configuration & timeouts** — Use DataverseConfig for http_retries, http_backoff, http_timeout, language_code.
6. **Cache management** — Flush picklist cache when metadata changes.
7. **File operations** — Upload large files in chunks; handle chunked vs. simple upload.
8. **Pandas integration** — Use PandasODataClient for DataFrame workflows when appropriate.

Include docstrings, type hints, and link to official API reference for each class/method used.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `dataverse-python-advanced-patterns`: Generate production code for Dataverse SDK using advanced patterns, error handling, and optimization techniques.
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
