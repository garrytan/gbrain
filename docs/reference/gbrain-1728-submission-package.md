# gbrain #1728 - Submission Package

> Branch: `fix/1728-import-checkpoint-staging-first`
> Issue: https://github.com/garrytan/gbrain/issues/1728
> Companion mitigation: https://github.com/garrytan/gstack/pull/1827

---

## Plan Summary

`gbrain import <dir>` writes `~/.gbrain/import-checkpoint.json` so interrupted imports can resume. The checkpoint currently uses the caller's raw `dir` argument as the run identity. That is too weak for a data-loss boundary because downstream tooling may treat the checkpoint `dir` as an owned staging directory.

The fix is to capture the import target once at import start as an absolute, resolved path and use that one value everywhere checkpoint state needs a directory identity.

## Premises

| Premise | Verdict | Reason |
|---|---|---|
| Checkpoint `dir` is a contract, not display text | Accepted | gstack consumed it as a resume/delete boundary. Bad contract, real data loss. |
| The path must be canonical at the producer | Accepted | Consumers should not guess whether `.` means the import target, the process CWD, or a symlinked alias. |
| Existing path-based checkpoints should remain readable when safe | Accepted | Current format is already better than old positional checkpoints. Refusing all old files would waste work. |
| Schema metadata should be additive | Accepted | A version/kind/owner tag lets future consumers validate without breaking current path-based resume. |

## What Already Exists

| Need | Existing code |
|---|---|
| Checkpoint load/save/clear | `src/core/import-checkpoint.ts` |
| Import entry point | `src/commands/import.ts#runImport` |
| Existing regression surface | `test/import-checkpoint.test.ts` |
| Docs surface for downstream agents | `docs/guides/live-sync.md`, `docs/GBRAIN_VERIFY.md` |

## Architecture

```text
CLI args
  |
  v
runImport()
  |
  | capture importTargetDir = realpathSync(resolve(dirArg))
  v
collectSyncableFiles(importTargetDir)
  |
  v
loadCheckpoint(checkpointPath, importTargetDir)
  |
  v
saveCheckpoint({ schema_version: 1, owner: "gbrain", kind: "import", dir: importTargetDir, completedPaths })
```

## Failure Modes Registry

| Failure mode | Impact | Fix |
|---|---|---|
| `dir` is `.` or relative | Resume identity depends on CWD | Canonicalize once with `resolve` + `realpathSync`. |
| `dir` is a symlink alias | Resume can mismatch same physical import target | Store realpath, not spelling. |
| Old positional checkpoint | Can skip files after crash | Existing loader already rejects and logs. |
| Malformed checkpoint | Consumer may trust garbage | Loader returns null unless shape validates. |
| Third-party checkpoint with matching fields | Consumer cannot identify producer | Add `schema_version`, `owner`, `kind`. |

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Fix producer contract in gbrain, not just gstack guard | Mechanical | Completeness | gstack PR protects deletion; gbrain must stop emitting ambiguous checkpoint identity. | Leave upstream issue as docs-only |
| 2 | Eng | Canonicalize at `runImport` entry | Mechanical | Explicit over clever | One stable variable threads through collect, relative paths, checkpoint load/save, git continuity. | Canonicalize inside every checkpoint helper |
| 3 | Eng | Add additive metadata, keep current completedPaths format | Mechanical | Pragmatic | Consumers gain validation fields without forcing a disruptive checkpoint migration. | Rename or redesign the checkpoint file |
| 4 | DX | Document checkpoint contract for downstream agents | Mechanical | Bias toward action | The bug happened at an integration boundary. The contract needs to be written down. | Only rely on tests/code comments |

## Test Plan

| Codepath | Test |
|---|---|
| Save checkpoint payload | Assert schema metadata and sorted paths in `test/import-checkpoint.test.ts`. |
| Load legacy path-based checkpoint | Assert old safe payload still loads and normalizes to v1 in memory. |
| Import target canonicalization | Add regression for relative/symlink spelling so checkpoint `dir` equals real target path, not CWD spelling. |
| Old positional checkpoint | Keep existing rejection/log test. |

## Scope

In scope:
- `src/commands/import.ts`
- `src/core/import-checkpoint.ts`
- `test/import-checkpoint.test.ts`
- checkpoint contract docs

Not in scope:
- gstack's deletion guard, already handled in gstack PR #1827.
- Replacing file-backed import checkpoints with `op_checkpoints`.
- Changing sync/import data model beyond the checkpoint identity contract.
