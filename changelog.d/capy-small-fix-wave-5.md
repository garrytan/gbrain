**`gbrain repair agent-session-facts` finishes its preview on brains with tens of thousands of saved facts, and `gbrain setup claude-code` no longer fails its re-run after Claude Code rewrites its settings file.**

### Fixed
- `gbrain repair agent-session-facts` (and doctor's `agent_session_facts` check) no longer times out on a large brain. The preview fingerprinted the source's facts once for every user-attributed fact saved from a session, before it knew whether that session was an agent's; it now looks for the owner's own copy only for facts whose session it already judged evidenced or ambiguous, using the existing fingerprint index, and it reads each take's contributing facts in one pass instead of one lookup per take. On a generated brain with 143,640 facts and 7,045 sessions the preview went from a statement timeout to about 1.5 seconds (#9503).
- `gbrain setup claude-code` re-run no longer exits 1 with `turn_hook_not_loaded` (and doctor's `harness_wiring` no longer warns) when Claude Code has rewritten `~/.claude/settings.json` without the `_gbrain` key on gbrain's hook entries. The per-turn hook check now recognises an entry the setup receipt owns, the same way setup itself does (#9505).
- `gbrain errors migration_host_work_owed` explains the doctor warning instead of printing "Unknown error code".
- `gbrain sources git-reconcile` treats a git command that ran past its time limit or was killed from outside (`git_command_stopped`) as a retryable failure (exit 4) instead of asking the user (exit 1). A git command stopped by its output limit or by a git crash still asks the user, since a retry stops the same way.
- `gbrain git commit-push` refuses with `git_unavailable` when it cannot list conflicted files, instead of reading a failed listing as "no conflicts". A write-through file refused for unresolved conflicts is kept in the pending ledger, so doctor reports it and `--pending` retries it, while later write-throughs still commit the ledger's other files, and the advice now says to keep the changes from both sides rather than to pick one side, since one side may be a write gbrain made.
- A git child that crashes (SIGSEGV, SIGBUS, SIGILL, SIGFPE or SIGABRT) is reported as a crash with a `git fsck` suggestion, not as a kill from outside gbrain, and output too large for one string is reported as `git_command_stopped` (`output_limit`) instead of an empty listing.

### Tests and CI
- The unit suite runs on 36 shards instead of 34, with refreshed shard weights, which brings the predicted time per shard from about 595 s to about 562 s.
- A test now covers `scripts/check-migration-projection.ts` and its baseline, and macOS 26 validation records the tree it tested so a passed run can stand as evidence for the same tree.

<!-- behavior-change: setup_turn_hook_unmarked_9505 -->
<!-- behavior-change: git_reconcile_stopped_retryable -->
