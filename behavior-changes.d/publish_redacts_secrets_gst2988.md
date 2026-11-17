---
kind: default
---
A push of a brain checkout no longer stops when the commits it is about to push hold a value that looks like a secret. gbrain now rebuilds those unpushed commits with secret store markers (<REDACTED:rule:ss_...>), keeps each original in the encrypted secret store, keeps the old commits on this machine for 7 days under refs/gbrain/backup/, and pushes. Commits a remote already has are never rewritten, and files the scan cannot vouch for, or changes to .gbrain-scan-allow or .gitattributes, stay on this machine in one held commit. Pushes held by the old refusal are retried by the next maintenance pass; the upgrade itself writes nothing. To keep the old refusal, run gbrain config set secrets.on_push refuse or set GBRAIN_SECRETS_ON_PUSH=refuse.
