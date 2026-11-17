---
important: security
---
**Conversation archive pages written while a brain was personal are now kept to the owner as soon as a command makes the brain shared, instead of staying readable by every member until the next archive run.**

<!-- behavior-change: archive_rescope_on_shared_9563 -->

### Fixed
- `gbrain access member add` and `gbrain access member enable` (when they make two or more enabled members), `gbrain config set brain.audience shared` and `gbrain access owner set` now apply the owner-only rules to the conversation archive before they return. `member add` and `member enable` do it before the member is added, enabled or bound to a token, and change nothing if it fails; a `member add` refused for its own input (a bad kind, email or group) changes nothing either. Each command prints one line on stderr per archive source; `--json` output is unchanged. (#9563)
- Still waiting, and named by `gbrain transcripts archive status` and `gbrain doctor`: a brain that turns shared from client usage with no command run (`gbrain transcripts archive run` applies it), a shared brain with no owner (`gbrain access owner set <member>`), and access rules kept in git (add the `conversations/` owner-only rule to `.gbrain/access.yml`). Pages an archive run already in progress writes into new folders stay readable by members until the next run; with maintenance off, that run is manual.
