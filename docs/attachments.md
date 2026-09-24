# Native MCP attachments

Attachments preserve original binary files alongside a page. Notes remain searchable;
uploading a workbook does not automatically turn its cells into indexed memories.
Keep a useful summary in the owning page and cite the attachment's ID and SHA-256.

The host needs its normal `storage` configuration (local, S3 or Supabase), and
migration 165. No server paths or storage credentials are accepted from remote
callers. Existing host-only `file_*` operations retain their restrictions.

## Client usage

**Say to your agent:** “Save this workbook alongside the research note, preserve
the original file, and verify that you can download identical bytes.”

With a configured GBrain thin client and the attachment tools available:

```sh
gbrain files upload './Travel Data.xlsx' --page wiki/research/travel
gbrain files list wiki/research/travel
gbrain files download 123 --output './Travel Data-restored.xlsx'
```

The client prints the upload request UUID before transfer. On interruption, repeat
the upload command with `--request-id <same-uuid>` and the same file and metadata.
Downloads refuse to overwrite existing files and publish the destination only
after checksum verification. Byte transfer occurs inside the client process;
the model only needs to see metadata, not base64 payloads. The CLI uses the
existing `remote_mcp` configuration with a separately provisioned OAuth client ID
and secret. A harness connector token is not automatically available to the CLI.
No additional file server, port or storage credential is needed by the client.

## MCP protocol

1. `attachment_begin`: supply `request_id` (UUID), `page_slug`, `filename`,
   `size_bytes`, `sha256`, optional `mime_type` and `source_id`.
2. `attachment_write`: send `upload_id`, aligned `offset` and canonical
   `data_base64`. Identical chunks are idempotent; changed chunks conflict.
3. `attachment_complete`: verify completeness and full-file checksum, upload to
   the configured backend, read back and verify, then register in `files`.
   A `state: complete` receipt is the save acknowledgement. Repeat completion
   after an ambiguous connection failure; never infer success from staged chunks.
4. `attachment_list`: page-scoped metadata with `after_id` pagination.
5. `attachment_read`: `attachment_id` and optional byte `offset`; returns bounded
   base64, `next_offset`, `eof`, total size and checksum. Verify the assembled file.
6. `attachment_abort`: discard a pending upload's database chunks. Completed
   attachments cannot be removed by this operation.

Writes require `write`; list/read require `read`. Tool bindings and the server's
MCP surface still apply. The starter surface includes attachment tools. Existing
clients retain their saved operation grants: an operator must add these six
operations explicitly with `auth rescope-client --allowed-operations`, preserving
the rest of the grant. A verbs-only surface must also be expanded. Upload sessions belong to their initiating authenticated
principal. Each request rechecks the source, current page visibility and write
fences. Attachments of private, deleted or archived pages are not remotely
readable. File names are display metadata; storage keys are opaque UUIDs.

## Limits and lifecycle

- 64 MiB maximum file, 256 KiB decoded chunks. Base64 stays inside ordinary MCP
  JSON tool arguments. Transport and reverse-proxy body limits must allow the
  encoded chunk and envelope; the legacy HTTP transport has a 1 MiB default,
  while the OAuth server uses a separate transport.
- Eight pending uploads per source. Pending sessions expire after 24 hours and
  are pruned on the next upload admission. Staging uses the database, so in-flight
  uploads survive service restarts. Completed chunks are removed immediately.
- Completed and aborted receipts remain for replay safety. A new upload creates
  a new immutable file; the same filename never silently replaces an old file.
- Completion buffers up to 64 MiB and holds a transaction while writing storage.
  New uploads store a versioned SHA-256 manifest for each chunk. Local, S3 and
  Supabase reads fetch and verify only the requested chunks (at most two for an
  unaligned offset). An aligned full download reads one file worth of backend
  bytes. Partial reads cannot detect corruption outside those chunks. The client
  must verify the final whole-file checksum. Legacy files without a matching
  manifest retain full-file verification on every read; reads never rewrite metadata.
- Storage and PostgreSQL have no shared transaction. A process/database failure
  after object upload can leave an unregistered object. Retrying completion uses
  the same immutable key and repairs the registration. Aborting/expiring such an
  upload may leave that object for operator reconciliation; do not delete unknown
  objects automatically. Never delete a completed object after an ambiguous commit.
- Back up both database and the configured attachment backend. A database-only
  backup cannot restore completed file contents.
- All remotely exposed `files` rows require a stable `page_id` and matching
  source. A legacy record with only a page slug remains available through the
  existing host-only tools; explicitly reupload/adopt it as an operator before
  exposing it remotely. Matching today's slug cannot establish ownership of old
  bytes. Already-bound legacy files also require the configured backend and a
  verified size/hash to download. Migration never guesses or rewrites ownership.

Migration 165 adds upload staging without rewriting existing file ownership.
Operators running an unpublished extension that reused an upstream migration
number must resolve that collision before upgrading; renumbering source alone
cannot repair a database migration already marked applied.
