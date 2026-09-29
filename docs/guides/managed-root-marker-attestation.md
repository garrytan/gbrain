# Attest a legacy managed Git marker

A `version: 1` `.git/gbrain-managed.json` marker has no owner-home or root-scope proof. It refuses filesystem writes throughout its Git root, even when a local registry appears to list only descendants. GBrain never upgrades it during connect or root refresh.

Use this procedure only for a verified legacy marker that was written at an enclosing Git root for Git-less managed descendants. Stop writers first. Identify the home that originally wrote the marker; it may differ from the current `GBRAIN_HOME` and from the Git root. Inspect that home's `.gbrain/persistence/managed-roots/*.json` records, including stale records and all brain IDs. Confirm that the marker brain ID belongs to that registry and enumerate **every canonical root under the Git root**. If ownership or completeness cannot be established, leave v1 in place.

From this checkout, run the local, explicit attestation command with the verified values:

```bash
bun scripts/persistence/attest-managed-git-marker.ts \
  --git-root /absolute/git-root \
  --owner-home /absolute/verified-owner-home \
  --brain-id 00000000-0000-0000-0000-000000000000 \
  --roots-json '["/absolute/git-root/brain", "/absolute/git-root/connectors/stale"]' \
  --attest-owner-and-complete-roots
```

The command requires an exact match between `--roots-json` and every root in the named owner's registry beneath the Git root. It rejects missing, malformed, external, or symlink-aliased roots and a mismatched v1 brain ID. It first writes a private `.v1-backup-<uuid>` beside the marker, then atomically writes a `version: 2` marker with `owner_home` and `scope_roots`; it prints the marker, backup, and scope paths. Keep the backup for rollback. A v2 reader checks the named registry again and refuses broadly if scope evidence is missing, damaged, or newly incomplete. New Git-less roots retain their own root-local markers; an actual registered Git root remains fenced in full.

The command cannot independently prove that the named home is the marker's historical owner or that another home's unknown stale roots do not exist. Those are the operator attestations required before running it. Never infer them from the current `GBRAIN_HOME` alone.
