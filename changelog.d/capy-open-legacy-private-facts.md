**New `gbrain repair open-facts` lets the operator open facts saved private before the world default, after a preview, with an undo.**

<!-- behavior-change: open_facts_repair_8194 -->

### Added
- `gbrain repair open-facts --source <id> --created-before <ISO-8601>` previews the active private facts saved before that instant, counts every fact it leaves private by reason (private, missing or quarantined pages, member pages, withdrawn, contested, expired, superseded), and `--apply --expect <hash>` opens exactly that window in place, keeping ids and trust tiers (Discussion #8194).
- Facts with no page and transcript-lane facts are listed apart and open only with `--class unpaged:<lane>`; `--ids-file` narrows the set; `--undo <ledger>` re-privates what a run opened.
- The command runs only from the CLI on the brain host: remote callers, member mode (`GBRAIN_ENFORCED_MEMBER`), `repair --all`, doctor and the remediation plan never run it. Nothing changes until an operator runs it.
- A fact made private on purpose before the cutoff is opened with the legacy ones, so read the preview or narrow the run with `--ids-file`.
- A fact with an end date (`valid_until`) in the past that was never expired or superseded is opened like a current one; a follow-up leaves it private.
- A fact whose table sits in a page's timeline is left private; a follow-up opens it.
