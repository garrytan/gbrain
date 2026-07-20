---
name: swiftui-skills
description: Apple-authored SwiftUI and platform guidance extracted from Xcode. Helps AI agents write idiomatic, Apple-native SwiftUI with reduced hallucinations.
metadata:
  openclaw:
    os: ["darwin"]
    requires:
      bins: ["xcodebuild"]
---

# swiftui-skills

## What this is

A packaged set of Apple-authored AdditionalDocumentation shipped inside Xcode, plus prompts that enforce Apple-native patterns and reduce hallucinations for developer-focused coding workflows.

## Source of truth

All factual claims and APIs must be grounded in files under `/docs`.

## How to use

- If you are writing code: pick the relevant doc(s), summarize the applicable rules, then produce compile-ready Swift code.
- If you are reviewing code: list issues and improvements, referencing doc(s) used.
- If uncertain: ask at most 1 question, only if the answer changes architecture.

## Setup check

If the `docs/` folder is empty or contains no `.md` files, the Xcode documentation has not been extracted yet.
Tell the user to run the setup script from the installed skill directory:

```
# Shared agent install
~/.agents/skills/swiftui-skills/setup.sh

# OpenClaw shared install
~/.openclaw/skills/swiftui-skills/setup.sh

# OpenClaw workspace install
./skills/swiftui-skills/setup.sh

# Project-local agent install
./.agents/skills/swiftui-skills/setup.sh
```

Do not proceed with SwiftUI guidance until docs are available.

## Non-negotiables

- Do not invent types or APIs. If it is not in `/docs`, say so and offer a safe alternative.
- Prefer minimal, idiomatic SwiftUI and platform conventions.
- Include availability notes when APIs are new.

## Output format

1. Selected docs (filenames)
2. Plan (3 to 6 bullets)
3. Code (full files or a single cohesive snippet)
4. Why this matches Apple docs (2 to 5 bullets)
5. Pitfalls (short)


## Contract

This skill guarantees:

- Covers its source domain per the skill description: Apple-authored SwiftUI and platform guidance extracted from Xcode. Helps AI agents write idiomatic, Apple-native SwiftUI with reduced hallucinations.
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
