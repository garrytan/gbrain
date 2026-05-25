# Refresh algorithm (diff-and-propose)

`gbrain integrations install agent-voice --refresh` re-walks the manifest, classifies every file into one of five states, and lets the operator decide per-file. The reference implementation is in `src/commands/integrations.ts` under the `install_kind: copy-into-host-repo` branch.

## State machine

For each file declared in `install/manifest.json`:

```
Let src_hash    = SHA-256 of gbrain-side file at manifest.src
Let host_path   = <target-repo>/<manifest.target>
Let recorded   = .gbrain-source.json.files[].sha256 for this entry (or absent if first refresh)
Let host_hash  = SHA-256 of host_path (or absent if file deleted on host side)

State:
  - "unchanged-identical"  iff host_hash == src_hash
                           → no-op
  - "unchanged-stale"      iff host_hash == recorded AND host_hash != src_hash
                           → operator unmodified, source moved → offer update
  - "locally-modified"     iff host_hash != recorded AND host_hash != src_hash AND host_hash is defined
                           → operator edited locally; offer three options (see below)
  - "host-deleted"         iff host_hash is absent AND src exists
                           → operator removed the file; offer to restore or to remove from manifest
  - "source-deleted"       iff src is absent AND host_hash is defined
                           → gbrain reference removed the file; offer cleanup (remove from host)
```

A path-mapping renames table in the manifest (`renames: [{from, to}]`, not yet shipped) allows the refresh algorithm to detect a source-renamed file as a logical update rather than a delete+add.

## "Locally-modified" decision

When a file shows `locally-modified`, the operator picks one of three options:

- **keep-mine** — leave host file untouched. The manifest entry's `sha256` is updated to the current host hash (the operator's edit becomes the new "recorded" baseline; future refreshes won't re-flag it until they edit it again OR the source changes).
- **take-theirs** — copy the gbrain reference over the host file. The recorded SHA becomes the new src_hash.
- **merge** — print a unified diff. Operator hand-merges in their editor; the refresh command exits without writing. Re-run `--refresh` after the merge to confirm.

## Transaction journal

`<target-repo>/services/voice-agent/.gbrain-source.refresh.log` is a JSONL append-only file. Each line records:

```json
{"ts": "2026-05-17T12:34:56Z", "src": "code/server.mjs", "state": "locally-modified", "decision": "keep-mine"}
```

The journal exists for two reasons:
1. **Partial-apply recovery.** If the refresh is interrupted mid-loop (Ctrl-C, crash, machine reboot), re-running `--refresh` reads the journal and resumes where it stopped.
2. **Audit.** Operators can grep the journal to see which files were touched and why.

The journal is rotated by file size (>1MB triggers rename to `.gbrain-source.refresh.log.1`) and ignored by `--refresh`'s own scan (the journal is host-only metadata, not a managed file).

## Concurrent refresh guard

`--refresh` acquires an advisory file lock at `<target-repo>/services/voice-agent/.gbrain-source.refresh.lock` for the duration of the run. Concurrent `--refresh` invocations on the same host repo fail-fast with "refresh already in progress."

## CLI surface

```bash
gbrain integrations install agent-voice --target <repo> --refresh
gbrain integrations install agent-voice --target <repo> --refresh --dry-run     # report-only
gbrain integrations install agent-voice --target <repo> --refresh --auto take-theirs   # non-interactive
gbrain integrations install agent-voice --target <repo> --refresh --auto keep-mine     # bias toward operator's edits
```

`--auto <decision>` applies the named decision to ALL `locally-modified` files without prompting. Useful for CI lanes that want either "always take upstream" or "always preserve local" without operator interaction.

## What this v0 deliberately skips

- Conflict resolution for files that exist in both manifests but at different paths (treated as add+delete).
- Concurrent edits on the SAME file mid-refresh (the advisory lock + per-file atomic write covers this).
- Semantic merges (we offer file-level diff only; no per-hunk picking).
- Manifest schema migration (v0.1.0 → v0.2.0 changes are handled by the install command refusing to refresh old manifests and asking the operator to re-install).

Each of those is a follow-up TODO.
