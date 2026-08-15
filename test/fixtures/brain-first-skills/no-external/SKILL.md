---
name: no-external
description: Skill that operates purely on local state
triggers:
  - "rotate the log file"
mutating: true
---

# no-external

This skill rotates log files locally. No external APIs, no brain queries.
Trivially exempt from brain-first compliance because there's nothing
to consult.

## How

Read the log path from config, rename to .log.1, truncate the active file.
