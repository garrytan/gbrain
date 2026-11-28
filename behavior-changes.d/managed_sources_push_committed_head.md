---
kind: add
---
On an activated managed checkout, gbrain sources push now retries the existing committed HEAD to its tracking branch on the owner host. It scans the unpublished commits and binary blobs for secrets and deny-listed paths under the owner and publish locks, and never stages, commits, pulls, integrates or runs checkout hooks. Dirty and staged files stay local. A divergent remote or history that cannot be scanned refuses. Automatic Git effects retain their existing redaction and integration behavior.
