**Sync no longer holds a note that matches an earlier committed version of its file just because it has no import record; it imports the Git edit, and doctor's held-files advice now points at one preview for all of them.**

<!-- behavior-change: sync_unknown_drift_history_gst3328 -->

### Fixed
- A note imported by an older gbrain has no import record, so when its file changed in Git, sync compared the note only with the file at the last synced commit. A note one commit or more behind its file, or whose last synced commit no longer resolves, was held as `file_drift` even though only Git had moved. Sync now also compares such a note with its file's three earlier committed versions, as it already did when re-screening holds an older gbrain wrote, and imports the edit when one matches. A note edited in the database still matches none of them and stays held.
- Holds that were already written are not re-screened on upgrade. `gbrain repair file-drift --source <id> --held` (writes nothing) now marks each held note that equals an earlier version of its file, names the commit, and says `gbrain sources retry-held <id>` and the next sync will import it with no repair.
- `gbrain doctor`'s `git_held_files` advice for file-drift holds now names that one whole-set preview, plus `retry-held` and the whole-class `--prefer file` approval, instead of a `--slug <slug>` step per note. On a read-only mirror it no longer points at the deleted-files preview, which listed none of the mirror's other drift holds.
- When the preview cannot read a held note's file (for example invalid UTF-8, or frontmatter that cannot be parsed losslessly), it now shows the reason with the error code, such as `invalid_params: The canonical file must contain valid UTF-8.`, instead of the bare code.
