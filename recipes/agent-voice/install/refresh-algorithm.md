# Refresh algorithm (diff-and-propose)

`gbrain integrations install agent-voice --refresh` re-walks the manifest, classifies every file into one of six states, and applies a deterministic decision per state. The implementation is in `src/commands/integrations.ts` under the `install_kind: copy-into-host-repo` branch (`refreshRecipeIntoHostRepo` / `classifyForRefresh`).

This file is the single home for refresh semantics. `recipes/agent-voice.md` and `install/post-install-hint.md` summarize and link here.

## State machine

For each file declared in `install/manifest.json` (plus each file in the prior install record):

```
Let src_hash   = SHA-256 of gbrain-side file at manifest.src
Let host_path  = <target-repo>/<manifest.target>
Let recorded   = .gbrain-source.json.files[].sha256 for this entry (absent if new)
Let host_hash  = SHA-256 of host_path (absent if file missing on host side)

State (and what refresh does about it):
  - "unchanged-identical"  iff host_hash == src_hash
                           → no-op
  - "unchanged-stale"      iff host_hash == recorded AND host_hash != src_hash
                           → operator unmodified, source moved → auto-updated (copied over)
  - "locally-modified"     iff host_hash != recorded AND host_hash != src_hash AND host exists
                           → operator edited locally → default keep-mine; see below
  - "host-deleted"         iff host file absent AND src exists
                           → left deleted, UNLESS --auto take-theirs (restores the file)
  - "source-deleted"       iff entry in the prior record but not in the current manifest
                           → left in place ("orphan"), UNLESS --auto take-theirs (removes it)
  - "new-in-manifest"      iff entry in the manifest but not in the prior record
                           → auto-installed (copied in)
```

There is no interactive per-file prompt: every run is non-interactive, and the only lever is `--auto keep-mine|take-theirs`. Without `--auto`, the defaults above apply (they match `--auto keep-mine`). Run `--dry-run` first to see the per-file classification before anything is written.

A path-mapping renames table in the manifest (`renames: [{from, to}]`, not yet shipped) would let refresh detect a source-renamed file as a logical update rather than a delete+add.

## The "locally-modified" decision

- **keep-mine** (the default) — leave the host file untouched. The recorded `sha256` in `.gbrain-source.json` is re-baselined to the current host hash, so future refreshes won't re-flag this file until either side changes again.
- **take-theirs** (`--auto take-theirs`) — copy the gbrain reference over the host file. The recorded SHA becomes the new src_hash.

There is no `merge` option and no diff output. To hand-merge: run `--dry-run` to find locally-modified files, diff them yourself against the gbrain-side reference (the `src` path printed per file), merge in your editor, then re-run `--refresh`.

## Transaction journal (audit log)

`<target-repo>/services/voice-agent/.gbrain-source.refresh.log` is a JSONL append-only file. Each line records one refresh event:

```json
{"ts": "2026-05-17T12:34:56Z", "event": "preserved_local", "src": "code/server.mjs", "target": "services/voice-agent/code/server.mjs", "decision": "keep-mine"}
```

The journal is an **audit log only** — grep it to see which files were touched by which refresh and why. It is never read back by `--refresh` (every run re-classifies from scratch), it is not rotated, and it is ignored by the scan itself (host-only metadata, not a managed file). Delete or truncate it whenever you like.

## CLI surface

```bash
gbrain integrations install agent-voice --target <repo> --refresh
gbrain integrations install agent-voice --target <repo> --refresh --dry-run              # report-only, per-file detail
gbrain integrations install agent-voice --target <repo> --refresh --auto take-theirs     # always take upstream
gbrain integrations install agent-voice --target <repo> --refresh --auto keep-mine       # explicit form of the default
```

`--auto <decision>` applies the named decision to ALL `locally-modified` files (and, for `take-theirs`, also restores host-deleted files and cleans up source-deleted orphans). Useful for CI lanes.

## What this v0 deliberately skips

- **Interactive per-file prompting and a merge option** — every run is batch; hand-merges happen in your editor between a `--dry-run` and a re-run.
- **Journal replay / partial-apply resume** — an interrupted refresh is simply re-run; classification is recomputed from scratch, and completed copies classify as `unchanged-identical` on the second pass.
- **Journal rotation** — the log grows unbounded (slowly); truncate it yourself if it bothers you.
- **A concurrent-refresh lock** — don't run two refreshes against the same host repo at once.
- Renamed-path detection (the `renames` table above).
- Semantic merges (file-level only; no per-hunk picking).
- Manifest schema migration (breaking manifest changes are handled by the install command refusing to refresh and asking the operator to re-install).

Each of those is a follow-up TODO.
