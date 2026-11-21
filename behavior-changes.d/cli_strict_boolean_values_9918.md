---
kind: breaking
exception: data-loss
---
CLI operation boolean flags now accept only true or false when given an explicit inline value. Values such as --purge=0, --include-deleted=no, --json=off and --dry-run=0 refuse with invalid_params rather than silently enabling the flag. Use =false to disable a flag, =true to enable it, or retain the bare flag to enable it. This prevents ambiguous input from selecting irreversible purge.
