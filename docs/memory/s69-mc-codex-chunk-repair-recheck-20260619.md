# s69-mc-codex Chunk Repair Recheck

Recorded: 2026-06-19 20:52:35 +08:00
Owner/prefix: `s69-mc-codex-`

## Memory

- Old todo item `true chunk-level multi-episode repair` is closed in current code.
- `repair.repair_chunk()` exists for contiguous multi-episode repair.
- `chunk.drive_chunked()` calls `_repair.repair_chunk(...)` on batch failure when `require_ready=True` and repair budget remains, then revalidates via `_evaluate_chunk_records()`.
- Offline tests passed:
  - `test_chunk_safety.py + test_repair.py`: 9 passed
  - writer `-k "chunk or repair"`: 21 passed / 177 deselected

## Evidence

- Project commit: `64acde19 docs: record chunk repair recheck`
- Project logs: `G:\codex-project\s69-mc-codex\619.md`, `G:\codex-project\s69-mc-codex\619todo.md`
