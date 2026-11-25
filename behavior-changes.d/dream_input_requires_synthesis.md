---
kind: fix
---
`gbrain dream --input <file>` still selects synthesis on its own. If you also specify phases, include `--phase synthesize`. A phase list without synthesis now fails before running instead of silently ignoring the file.
