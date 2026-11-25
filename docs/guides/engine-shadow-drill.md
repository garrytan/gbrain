# Engine shadow drill (criterion 10)

How `gbrain engine shadow drill` runs the restore drill on the shadow store and the eval-gates fetch, and what `status` and the swap read from them. This page holds the whole Drill item of [Rust engine shadow mode](../ENGINES.md); it lives here so `llms-full.txt`, which inlines the engines page, stays under its size cap.

The command, as it was listed with the other `gbrain engine shadow` commands:

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
  `backup_restore_passed` is true only for a record of the current evidence epoch whose scratch space was seen deleted,
  `eval_gates_e1_e3` is decided again on every read from the cached files, and `backup_state`, `backup_reason`,
  `eval_gates_reason` and `eval_gates_last_fetch` say why a half is not a pass. The drill's refusals are the error code
  `shadow_drill_failed`; `docs/guides/engine-swap.md` (criterion 10) has the swap's side.
