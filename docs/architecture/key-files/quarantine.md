# Content-quality quarantine (key files cluster)

[Subsystem index](../KEY_FILES.md).

What a page the content-quality gate hid as junk may do and what readers and
writers are told (#1699, #6259). The markers themselves are in
`src/core/quarantine.ts` ([files and sync](files-and-sync-1.md)); the operator
surface is `src/commands/quarantine.ts` ([commands](commands-4-continued.md)).

**Trust boundary.** `stripGateOwnedMarkers` (`src/core/import-screen.ts`,
called once by `importFromContent`) removes `GATE_OWNED_FRONTMATTER_KEYS`
(`quarantine`, `content_flag`, `embed_skip`, `atoms_scan_hash`,
`quarantine_override`) from every write unless an owner-tier path passes
`preserveGateMarkers: true`: `importFromFile`, managed sync
(`persistence/sync-prepare.ts`) and file import (`import-prepare.ts`), reindex,
file repair, reconcile, the cycle derivers and their `managed_maintenance_page`
intents (`persistence/page-prepare.ts`), `quarantine clear/scan`, and the
owner-internal put_page kind `managed_quarantine_clear`
(`persistence/page-mutations.ts` `OWNER_FILE_INTENTS`). Local put_page,
connectors and ingest lanes are not owner-tier. `opts.remote` keeps only its
fence-merge and hidden-row meaning. Test: `test/gate-marker-strip.test.ts`.

**Derived data.** `isFactsBackstopEligible` returns `quarantined`; the
canonical projection and the unmanaged fence reconcilers (`cycle/extract-facts.ts`,
`cycle/extract-takes.ts`) project no facts or takes for a quarantined page and
leave rows projected before it as they are. Tests: `test/facts-eligibility.test.ts`,
`test/quarantine-fence-projection.test.ts`.

**What callers see.** A put_page the gate quarantined reports
`quarantined: { reason, detail }` (`quarantineOutcome`, set in
`persistence/page-prepare.ts`) and one `page_quarantined` safety notice
(`pageQuarantinedNotice`, emitted by `emitFenceNotice` in `page-mutations.ts`;
put_pages marks each page and emits one notice in `page-batch.ts`). get_page
(`ops/pages.ts`) carries `quarantined` and the notice, and so does `fetch`
(`metadata.quarantined`, both through `readQuarantined`); an untrusted reader
gets no body (fetch: empty `text`) unless it holds `admin` and passes
`include_quarantined: true`.
Test: `test/quarantine-read-write-surface.test.ts`.

- `src/core/quarantine-override.ts` — #6259 (fix wave 12): the `quarantine_override` frontmatter key `gbrain quarantine clear --force` records: `{ binding, cleared_at }`, where `binding` is a sha256 over the classifier's inputs (title, type, body) as the gate canonicalizes them (`quarantineOverrideFor`). `assessImportSanity` (`import-screen.ts`) wraps its verdict in `withQuarantineOverride`, which removes the junk-pattern, literal and markup-flag outcomes while the binding is current (size outcomes stay). `importFromContent` calls `stripGateOwnedMarkers` (`import-screen.ts`, `GATE_OWNED_FRONTMATTER_KEYS`): every writer loses `quarantine`, `content_flag`, `embed_skip`, `atoms_scan_hash` and `quarantine_override` unless an owner-tier path passes `preserveGateMarkers: true` (`importFromFile`, managed sync and file import, reindex, file repair, reconcile, the cycle derivers and their `managed_maintenance_page` intents, `quarantine clear/scan` and the owner-internal `managed_quarantine_clear` put_page kind); local put_page, connectors and ingest lanes do not. A preserving path keeps its own override only while current, and a current override drops classifier markers the content still carries. `opts.remote` keeps only its fence-merge/hidden-row meaning. Tests: `test/gate-marker-strip.test.ts`. For a stripped write the classifier would hide or markup-flag, `carryStoredQuarantineOverride` reads the stored override and keeps it when it still binds (so a remote tag edit does not re-hide the page); a clean remote write reads nothing extra (#6007 statement budget). Company-brain inspection refuses files carrying it (`hidden_input`). Doctor's quarantine row names `clear <slug> --force` and `content_sanity.disabled_patterns`.
- `src/core/ops/get-page-projection.ts` — `projectGetPage` shapes the get_page response from the reader-visible body (#2225 `content`, content_only round-trip fields, `timeline_entries`, `file_held`). #6259: `quarantinedView` decides whether a quarantined page's body is withheld (`body_omitted` for an untrusted reader without `admin` + `include_quarantined`); a withheld body empties compiled_truth and timeline and drops `content`.
