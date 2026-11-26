---
kind: default
---
gbrain setup <harness> --members <id,...> now sets up per-member access on its own: each person gets a member, a folder rule people/<id>/ only they read and a bound key, as --serves several --members did. Before, --members without --serves several was refused. --serves one with --members is refused. A setup that names no members is unchanged and stays a keyless one-person setup.
