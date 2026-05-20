---
keywords: code, python, javascript, bash, script, function, bug, error, debug, test, file
---

# Coding Skills

## Approach
1. Read the relevant file first before editing
2. Write the smallest change that fixes the problem
3. Verify with a test or dry-run before declaring done

## Bash sandbox rules
- PATH is restricted: only `/usr/bin:/bin` available
- Working directory is a fresh tempdir per call — no state persists between calls
- Network is available; use `curl` or `wget` for downloads

## Error handling
- Always check exit_code in bash output
- If exit_code != 0, read stderr carefully before retrying
