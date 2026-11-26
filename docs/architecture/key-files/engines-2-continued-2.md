# Key files: Engines (2/2, continued, 2)

[Subsystem index](../KEY_FILES.md) · [Previous entries](engines-2-continued.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/engine-sql/trust-scan.ts` + `rust/crates/gbrain-store/src/trust/scan_state.rs` + `persistence/trust_scan_cursor.rs` — the state reads and the cursor write `gbrain trust scan` (`eligibility/scan.ts`) and doctor `trust_scan` used to run through `executeRaw`: `readTrustScanCursor` / `writeTrustScanCursor` (the `op_checkpoints` row `trust_scan`/`v1`, scan.ts's SQL text; the Rust store keeps it as the resumable-op checkpoint parent row, so the
op-checkpoint members and the stale purge see it), `listClaimPendingSourceIds` (`claimPendingSql`;
the TS member sends `CONNECTOR_SOURCE_KINDS`) and `readTrustScanCeilings` (each scanned table's `max(id)`). A cursor read failure fails the
doctor check; it never reads as no cursor. Pinned by `test/engine-parity/trust-tier-reads.test.ts` (a scan that stops and resumes) on every arm and by `rust/crates/gbrain-store/tests/trust_scan_state.rs`.

Continued in [Engines (2/2, more)](engines-2-more.md).
