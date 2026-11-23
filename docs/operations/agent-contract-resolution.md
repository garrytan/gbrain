# Verify a historical agent-contract repair

Use the local host CLI after reproducing the original fault and verifying the repair on the executable that runs Doctor. The local event log lives in `agent-contract/events.jsonl` under the brain's configuration directory. The seven-day count of original events remains in `details.internal_errors`. The report also gives the verified and remaining counts.

Prepare a permission-0600 JSON manifest with these fields.

- `version` is `1`.
- `verified_binary_sha256` is the SHA-256 of the running gbrain executable.
- `proofs` lists one entry per historical event. Each entry includes the canonical JSON SHA-256 of the exact log record in `event_sha256`, an ISO verification timestamp in `verified_at`, the verification in `evidence`, and its canonical JSON SHA-256 in `evidence_sha256`. Canonical JSON uses sorted object keys and compact JSON.
- Each `evidence` records a machine-readable `probe`, the `observed_error_code`, `actionable_next_step: true`, `recovered: true`, and the SHA-256 of the observed reproduction and recovery artifacts in `reproduction_sha256` and `recovery_sha256`. Retain those artifacts and review them before submitting.

Preview the file and use the returned hash to approve the exact parsed manifest and event bindings.

```sh
gbrain repair agent-contract-resolve --evidence-file /path/to/evidence.json --json
gbrain repair agent-contract-resolve --evidence-file /path/to/evidence.json --apply --expect <preview-hash> --json
gbrain doctor --only agent_contract --json
```

A new occurrence has a different log-record digest. Revalidate against the replacement executable after upgrading. Consent refusals, spend caps and missing JSON documents continue to follow their own checks.
