# s69-PAI-codex global AGENTS boundary correction

Recorded: 2026-06-19 21:37:42 +08:00
Owner/prefix: `s69-PAI-codex-`

User correction:

Worktree-specific, branch-specific, lane-prefix, daily-log filename, and one-project reference facts must not be written into global `C:\Users\datoo\.codex\AGENTS.md`.

Boundary:

1. Global `AGENTS.md` may keep only cross-project behavior rules.
2. Concrete worktree paths, branch names, lane-specific log filenames, and project reference paths belong in project-local files and prefixed memory notes.
3. For this lane, keep project-local records under the project worktree and Codex-owned gbrain memory files with the `s69-PAI-codex-` prefix.

Action taken:

The global boundary sentence was generalized so it no longer names this lane's concrete log files.
