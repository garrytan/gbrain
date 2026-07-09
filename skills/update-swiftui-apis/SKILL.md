---
name: update-swiftui-apis
description: Scan Apple's SwiftUI documentation for deprecated APIs and update the SwiftUI Expert Skill with modern replacements. Use when asked to "update latest APIs", "refresh deprecated SwiftUI APIs", "check for new SwiftUI deprecations", "scan for API changes", or after a new iOS/Xcode release. Requires the Sosumi MCP to be available.
---

# Update SwiftUI APIs

Systematically scan Apple's developer documentation via the Sosumi MCP, identify deprecated SwiftUI APIs and their modern replacements, and update `swiftui-expert-skill/references/latest-apis.md`.

## Prerequisites

- **Sosumi MCP** must be enabled and available (provides `searchAppleDocumentation`, `fetchAppleDocumentation`, `fetchAppleVideoTranscript`, `fetchExternalDocumentation`)
- Write access to this repository (or a fork)

## Workflow

### 1. Understand current coverage

Read `swiftui-expert-skill/references/latest-apis.md` to understand:
- Which deprecated-to-modern transitions are already documented
- The version segments in use (iOS 15+, 16+, 17+, 18+, 26+)
- The Quick Lookup Table at the bottom

### 2. Load the scan manifest

Read `references/scan-manifest.md` (relative to this skill). It contains the categorized list of API areas, documentation paths, search queries, and WWDC video paths to scan.

### 3. Scan Apple documentation

For each category in the manifest:

1. Call `searchAppleDocumentation` with the listed queries to discover relevant pages.
2. Call `fetchAppleDocumentation` with specific documentation paths to get full API details.
3. Look for deprecation notices, "Deprecated" labels, and "Use ... instead" guidance.
4. Note the iOS version where the modern replacement became available.
5. Optionally call `fetchAppleVideoTranscript` for WWDC sessions that announce API changes.

Batch related searches together for efficiency. Focus on finding **new** deprecations not yet in `latest-apis.md`.

### 4. Compare and identify changes

Compare findings against existing entries. Categorize results:
- **New deprecations**: APIs not yet documented in `latest-apis.md`
- **Corrections**: Existing entries that need updating (wrong version, better replacement available)
- **New version segments**: If a new iOS version introduces deprecations, add a new section

### 5. Update latest-apis.md

Follow the established format exactly. Each entry must include:

**Section placement** -- place under the correct version segment:
- "Always Use (iOS 15+)" for long-deprecated APIs
- "When Targeting iOS 16+" / "17+" / "18+" / "26+" for version-gated changes

**Entry format:**

```markdown
**Always use `modernAPI()` instead of `deprecatedAPI()`.**

\```swift
// Modern
View()
    .modernAPI()

// Deprecated
View()
    .deprecatedAPI()
\```
```

**Quick Lookup Table** -- add a row at the bottom of the file:

```markdown
| `deprecatedAPI()` | `modernAPI()` | iOS XX+ |
```

Keep the attribution line at the top of the file:
> Based on a comparison of Apple's documentation using the Sosumi MCP, we found the latest recommended APIs to use.

### 6. Open a pull request

1. Create a branch from `main` named `update/latest-apis-YYYY-MM` (use current year and month).
2. Commit changes to `swiftui-expert-skill/references/latest-apis.md`.
3. Open a PR via `gh pr create` with:
   - **Title**: "Update latest SwiftUI APIs (Month Year)"
   - **Body**: Summary of new/changed entries, attribution to Sosumi MCP

## Sosumi MCP Tool Reference

| Tool | Parameters | Returns |
|------|-----------|---------|
| `searchAppleDocumentation` | `query` (string) | JSON with `results[]` containing `title`, `url`, `description`, `breadcrumbs`, `tags`, `type` |
| `fetchAppleDocumentation` | `path` (string, e.g. `/documentation/swiftui/view/foregroundstyle(_:)`) | Markdown documentation content |
| `fetchAppleVideoTranscript` | `path` (string, e.g. `/videos/play/wwdc2025/10133`) | Markdown transcript |
| `fetchExternalDocumentation` | `url` (string, full https URL) | Markdown documentation content |

## Tips

- Start broad with `searchAppleDocumentation` queries, then drill into specific paths with `fetchAppleDocumentation`.
- Apple's deprecation docs typically say "Deprecated" in the page and link to the replacement.
- WWDC "What's new in SwiftUI" sessions are the best source for newly introduced replacements.
- When unsure about the exact iOS version for a deprecation, verify by checking the "Availability" section in the fetched documentation.
- If an API is deprecated but no direct replacement exists, note this rather than suggesting an incorrect alternative.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: Scan Apple's SwiftUI documentation for deprecated APIs and update the SwiftUI Expert Skill with modern replacements. Use when asked to "update latest APIs", "refresh deprecated SwiftUI APIs", "check for new SwiftUI deprecations", "scan for API changes", or aft
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.
