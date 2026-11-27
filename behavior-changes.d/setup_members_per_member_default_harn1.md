---
kind: default
---
gbrain setup <harness> --members <id,...> now sets up per-member access on its own: each person gets a member, a folder rule people/<id>/ and a bound key, as --serves several --members did (a new rule lists only that person; an existing rule that also lists the owner is kept). Before, --members without --serves several was refused. --serves one with --members is refused, and so is --members on a run that cannot set members up (a harness other than claude-code or codex, --instructions-only, --remove, --skills-index-only, --wakeshift), which before ignored it with --serves several and exited 0; that refusal names the gbrain access serves several command to preview instead. A setup that names no members is unchanged and stays a keyless one-person setup.
