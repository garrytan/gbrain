**Held Git effects never print git's own error line, and a fix command for a checkout path with a line break names that exact path.**

<!-- behavior-change: managed_git_exact_fix_commands -->

### Fixed
- `gbrain sources writer retry-effects` (with and without `--dry-run`), the doctor `parked_effects` JSON and the `gbrain sources writer settle-effects` preview list each parked target's `last_error` as the step, the phase and a reason code only. An older build of this branch could also store the first line of git's error text there, which can hold a token, a private path or a URL password; that line no longer prints.
- Retrying, parking, re-arming, settling or un-settling a held Git effect, and declaring an ignored target during `gbrain sources canonical` conversion, stores its diagnostics in the same fixed shape, so a row an older build wrote loses the stored git line on its next rewrite. No migration runs: an untouched row keeps it on disk until then, and every read above drops it. A worker's attempt bookkeeping on a queued effect merges only its own fields, so it leaves a stored line in place until one of those rewrites.
- On the HTTP and MCP view, a private path that follows an escaped line break in a printed command (`$'label\012/home/...'`) is now masked like any other private path.
- A fix command for a checkout path that holds a line break, a control character or an `[AGENT]`-style marker now prints the exact path, on one line: the word is written in `$'...'` quoting with those characters, the quote, the backslash and `[` as three-digit octal byte escapes (`\012` for a line break), which no shell reads together with a following digit or letter. Before, the line break printed as a space, which names another path. This covers the rendered `command` and the commands inside `why` and `user_message` (the commit-identity edits and `git -C <checkout> status`).

### Blast radius
- `targets[].last_error` in `retry-effects` JSON, `effects[].parked[].last_error` in doctor `parked_effects` and `targets[].last_error` in `settle-effects` previews hold only `phase`, `step`, `reason` (and `identity: true` for a missing identity). A stored step outside the known step names reads `git`, and an unknown reason reads `other`; an entry with no usable diagnostic has no `last_error`.
- A command word with a control character, a line break, U+2028/U+2029 or a marker token prints as `$'...'` instead of a single-quoted word with the character replaced. Every other word prints as before.
- dash (Debian's `/bin/sh`) does not read `$'...'`: it reads one literal word that starts with `$`, so such a command does not reach the intended checkout there. No part of the path runs as a command. Use bash, zsh, ksh or busybox sh, or the exact `argv`.
