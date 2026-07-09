---
name: update-avm-modules-in-bicep
description: 'Update Azure Verified Modules (AVM) to latest versions in Bicep files.'
triggers:
  - "update-avm-modules-in-bicep"
  - "update avm modules in bicep"
  - "awesome copilot update avm modules in bicep"
---

# Update Azure Verified Modules in Bicep Files

Update Bicep file `${file}` to use latest Azure Verified Module (AVM) versions. Limit progress updates to non-breaking changes. Don't output information other than the final output table and summary.

## Process

1. **Scan**: Extract AVM modules and current versions from `${file}`
1. **Identify**: List all unique AVM modules used by matching `avm/res/{service}/{resource}` using `#search` tool
1. **Check**: Use `#fetch` tool to get latest version of each AVM module from MCR: `https://mcr.microsoft.com/v2/bicep/avm/res/{service}/{resource}/tags/list`
1. **Compare**: Parse semantic versions to identify AVM modules needing update
1. **Review**: For breaking changes, use `#fetch` tool to get docs from: `https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/{service}/{resource}`
1. **Update**: Apply version updates and parameter changes using `#editFiles` tool
1. **Validate**: Run `bicep lint` and `bicep build` using `#runCommands` tool to ensure compliance.
1. **Output**: Summarize changes in a table format with summary of updates below.

## Tool Usage

Always use tools `#search`, `#searchResults`,`#fetch`, `#editFiles`, `#runCommands`, `#todos` if available. Avoid writing code to perform tasks.

## Breaking Change Policy

⚠️ **PAUSE for approval** if updates involve:

- Incompatible parameter changes
- Security/compliance modifications
- Behavioral changes

## Output Format

Only display results in table with icons:

```markdown
| Module | Current | Latest | Status | Action | Docs |
|--------|---------|--------|--------|--------|------|
| avm/res/compute/vm | 0.1.0 | 0.2.0 | 🔄 | Updated | [📖](link) |
| avm/res/storage/account | 0.3.0 | 0.3.0 | ✅ | Current | [📖](link) |

### Summary of Updates

Describe updates made, any manual reviews needed or issues encountered.
```

## Icons

- 🔄 Updated
- ✅ Current
- ⚠️ Manual review required
- ❌ Failed
- 📖 Documentation

## Requirements

- Use MCR tags API only for version discovery
- Parse JSON tags array and sort by semantic versioning
- Maintain Bicep file validity and linting compliance


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `update-avm-modules-in-bicep`: Update Azure Verified Modules (AVM) to latest versions in Bicep files.
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
