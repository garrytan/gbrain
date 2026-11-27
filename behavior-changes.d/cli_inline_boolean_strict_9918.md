---
kind: breaking
exception: data-loss
---
An inline boolean flag on a gbrain command now takes only true or false. A value such as --purge=0, --include-deleted=no, --dry-run=off or --json=1 is refused with invalid_params (exit 2) and nothing runs; before, any value other than false turned the flag on, so gbrain delete <slug> --purge=0 ran the irreversible hard delete instead of the recoverable soft delete. Write the flag on its own or --flag=true to turn it on, and --flag=false to turn it off. The bare flag and the space-separated form (--purge false) are unchanged.
