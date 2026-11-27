---
kind: fix
---
A managed Git removal, page walk or conversion apply on a checkout with a configured upstream but no tracking ref now runs the guarded push (ask the remote, scan, push or hold) instead of reporting nothing to push and leaving the commit on this machine only. git_push_holds in sync status and doctor gains last_error (step and reason code), and the push_unconfirmed message names a reason code instead of copying git's error text. In gbrain sync status, every hold that asks the user (commit identity, push conflict or secret scan, fence) sets needs_human in --json and prints ASK THE USER in the text, whatever the next step is.
