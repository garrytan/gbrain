---
type: system
title: "<System Title>"
repo: "https://github.com/example/repo"
language: ["<Language>"]
build_command: "<build command>"
test_command: "<test command>"
key_entry_points:
  - name: "<Entry point name>"
    path: "<relative/path>"
    purpose: "<Why this path matters>"
tags: ["architecture"]
---

## Architecture Summary

<200-400 word summary of the system, its layers, and how requests flow through it.>

## Key Entry Points

| Entry Point | Path | Purpose |
|-------------|------|---------|
| <Entry point> | `<relative/path>` | <Purpose> |

## Component Map

- **<component/path>** — <one-line responsibility>

## Key Abstractions

- **<abstraction>**: <what it means in this system>

## Build & Run

- Build: `<build command>`
- Test: `<test command>`

---

## Timeline

- **YYYY-MM-DD** | System page created or updated from code exploration. [Source: Agent, code exploration session, YYYY-MM-DD HH:MM TZ]
