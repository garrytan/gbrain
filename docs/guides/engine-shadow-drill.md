# Engine shadow drill (criterion 10)

How `gbrain engine shadow drill` runs the restore drill on the shadow store and the eval-gates fetch, and what `status` and the swap read from them. This page is the full reference for the drill. [Rust engine shadow mode](../ENGINES.md) does not list it, so `llms-full.txt`, which inlines the engines page, stays under its size cap.

The command:

```
gbrain engine shadow drill [--backup] [--evals] [--json]   # restore drill on the shadow store and eval-gates fetch (swap criterion 10); both without a flag
```

- **Drill (swap criterion 10).** `gbrain engine shadow drill` runs on the shadow's host and never pauses the shadow.
  `--backup` asks the shadow's owner for one copy of the Rust store at one committed generation under
  `drills/scratch-<id>/` (the shadow keeps following), checks the copy without opening it normally, opens it once, runs
  a keyword search on a word the copy stores (up to 24 words are tried until one gets a hit), deletes the copy and writes
  `drills/backup.json` and `history.jsonl`. It verifies and opens the copy with the addon whose SHA-256 equals the epoch's `rust_addon_sha256` (`addon_mismatch`
  otherwise). A copy that has pages passes only after a keyword search ran on it, and while the copy's keyword index is
  complete that search must get a hit (`no_probe_term` otherwise); the probe drops the engine's stop words before it
  counts its 24 tries and leaves out pages under search-excluded slug prefixes. A shadow deleted or replaced during
  the drill is `shadow_gone` and nothing is written. `--evals` downloads the release's `gbrain-eval-gates.pin.json` and the eval-gates
  file it names into `drills/` (the only network use of the command; `status` and the swap never fetch). With neither
  flag both run, and the exit code is 1 unless every half that ran passed. `status --json` carries them as `drills`:
  `backup_restore_passed` is true only for a passed record of the current evidence epoch whose scratch space was seen deleted and while no `drills/pending.json` marker exists,
  `eval_gates_e1_e3` is decided again on every read from the cached files, and `backup_state`, `backup_reason`,
  `eval_gates_reason` and `eval_gates_last_fetch` say why a half is not a pass. The drill's refusals are the error code
  `shadow_drill_failed`; `docs/guides/engine-swap.md` (criterion 10) has the swap's side.
- **Cleanup, the pending marker and the lock.** Before it asks for the copy, the drill writes `drills/pending.json`. The
  marker goes away only once the scratch copy is deleted and the drill's result is on disk in `drills/backup.json` (or
  the shadow itself is gone, so nothing can be written). While the marker exists, `status` reads `cleanup_pending`, even
  next to an older passed record. The scratch copy is deleted only after the shadow's owner says the copy has ended (or the owner is certainly gone). When
  a copy call fails, the drill waits up to 30 seconds for that, and each question to the owner is bounded by the time
  left, so an owner that stops answering counts as still running: the drill leaves the scratch copy and the marker, the
  record says `scratch_deleted: false` (reason `cleanup_failed`, unless the copy's own stop reason came first) and the
  lock is released. A result that cannot be written is `drill_error`, and the drill also removes an earlier
  `backup.json`, so an old pass cannot stand for a drill that did not finish. The next drill clears an old marker only
  when the owner reports that copy ended (or the owner is gone); otherwise (or when the marker cannot be read) it stops with
  `cleanup_pending` and writes nothing. It then removes the old scratch copy, then the old `backup.json`, then the marker. If either removal cannot be
  done it stops with `cleanup_failed`, keeps the marker and writes nothing. The drill holds `drills/drill.lock` from
  before the copy until the result is written and the marker removed, on every path, so a second drill meanwhile is
  refused with `drill_running` and cannot overwrite a slower drill's result. A lock whose process is dead is taken over; a
  lock that cannot be read, or a `drills/drill.lock.takeover` left by a crash, keeps the drill refused until you remove it
  by hand. `gbrain engine shadow stop --delete` takes the same lock first (it makes `drills/` for the purpose when no drill has run yet, so a first drill cannot start under the delete): while a drill holds it, the stop refuses (exit 1,
  `drill_running`) and stops and deletes nothing, so run it again once the drill ends. The delete holds the lock until the rest of the shadow directory is gone, then removes `drills/` last. The drill also never opens a store
  that is gone: before each open (the shadow's own store, then the copy) it checks the shadow and the store still exist, and again after the imports that come right before the open.
