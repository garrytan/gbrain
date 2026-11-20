# Remote file transfer: upload, import and download over MCP

Status: in progress (fork branch `feat/remote-file-storage`).

## Problem

A brain served over HTTP (`gbrain serve --http`, a team brain behind a gateway,
a brain on a VM or in Kubernetes) can store binary files in a pluggable storage
backend (`storage: s3 | supabase | local`), and can index images (multimodal
embedding + OCR). But every operation that moves bytes is `localOnly`:

| Op | What it does | Remote today |
|---|---|---|
| `file_upload` | reads a **server-side path**, stores the bytes, writes a `files` row | refused (`localOnly`) |
| `gbrain import <image>` | reads a **server-side path**, builds an image page (vector + OCR) | CLI only |
| `file_list` | lists `files` rows | refused (`localOnly`) |
| `file_url` | presigned GET for a stored object | refused (`localOnly`) |

So an agent on a laptop talking to a remote brain cannot add an image or a
document to the brain, cannot make an image searchable, and cannot get a stored
file back. A teammate who imported a photo, or an agent that generated a
diagram, has no way to hand it to anyone else through the brain.

The `localOnly` flag is right for the existing ops: their input is a path on
the server's filesystem, and a remote caller must never name server paths. The
fix is a **byte-based** input lane, not lifting the flag on the path-based op.

## Design

### Two concerns, kept apart

1. **Moving bytes** depends on the backend.
2. **Recording and indexing** (the `files` row, the image page) does not: it
   reads the bytes back through `StorageBackend.download()`, which every
   backend has.

### Moving bytes: direct-to-storage when the backend can sign, inline otherwise

`StorageBackend` gains an optional method:

```ts
createUploadUrl?(path: string, opts: { mime?: string; expiresIn?: number }):
  Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }>;
```

- **S3-compatible** (AWS S3, GCS via its S3-interoperable XML API with HMAC
  keys, R2, MinIO): SigV4 presigned `PUT`, 15 minutes. The bytes go from the
  agent straight to the bucket; they never cross the MCP connection or the
  brain host's disk.
- **Backends without signing** (local; Supabase for now): the agent sends the
  bytes inline as base64 parts sized to fit the transport's request cap.

### Upload sessions

Session state lives in the storage backend itself, under a staging prefix, so
no schema migration is needed and the session works on every engine:

```
_incoming/<upload_id>/manifest.json   written by the server at begin
_incoming/<upload_id>/data            signed-PUT target (direct mode)
_incoming/<upload_id>/part-000001...  inline parts (parts mode)
```

The signed URL covers only `.../data`, so a caller can never write the
manifest. Commit re-reads everything from the backend and trusts nothing the
client claims without checking it.

### New and changed ops (all `scope: 'admin'`, remote-callable)

| Op | Params | Result |
|---|---|---|
| `file_upload_begin` | `filename`, `size_bytes`, `sha256`, `mime_type?`, `page_slug?`, `import?` | `upload_id`, `mode: direct \| parts`, and for direct: `url`, `method`, `headers`; for parts: `part_max_bytes` |
| `file_upload_part` | `upload_id`, `part` (1-based), `data_base64` | `received_bytes` |
| `file_upload_commit` | `upload_id` | `status`, `storage_path`, `size_bytes`, `mime_type`, and `import` result when requested |
| `file_upload_abort` | `upload_id` | deletes the staged objects |
| `file_list` | unchanged | no longer `localOnly` |
| `file_url` | unchanged | no longer `localOnly`; presigned GET (1 h) |
| `file_get` | `storage_path` | metadata, plus the bytes: an MCP `image` content block for images (the model sees the image), `data_base64` otherwise; refused with `result_too_large` above the connection's result cap (use `file_url`) |

`file_upload` (path-based) and `gbrain import` keep their exact behavior and
stay `localOnly` / CLI.

### Commit

1. Read the manifest; refuse an unknown, expired or other-source session.
2. Load the bytes (`data`, or the parts in order) — at most
   `GBRAIN_REMOTE_UPLOAD_MAX_BYTES` (default 100 MiB), in memory, never on disk.
3. Verify size and SHA-256 against the declared values; sniff the real type
   from magic bytes for images and PDFs.
4. Store at the same layout `file_upload` uses (`<page_slug>/<filename>` or
   `unsorted/<hash8>-<filename>`) through the same recording path: source
   check, foreign-attachment refusal, `already_exists` short-circuit, `files`
   row insert, rollback of the object if the insert fails.
5. With `import: true` and an image: run the image importer on the in-memory
   bytes with `relativePath = storage_path`, so the image page's `files` row
   is the stored object; then link the image page to `page_slug` (`image_of`).
   The import outcome is reported separately: a failed OCR or embedding never
   loses the stored original.
6. Delete the staged objects.

### Security

- Byte-based input only; remote callers still cannot name server paths.
- `admin` scope, as the existing file ops.
- A signed PUT URL is a bearer capability for one staging key, for 15 minutes.
  Commit re-verifies size, hash and type, so a tampered upload is refused.
- `file_list`, `file_url`, `file_get` keep the private-page filter
  (`fileReadableSql`): a caller sees no file attached to a page it cannot read.
- Stale staging objects: `file_upload_abort`, plus a bucket lifecycle rule on
  `_incoming/` (operator side).

### Agent flow

```
file_upload_begin {filename, size_bytes, sha256, page_slug, import: true}
  -> {upload_id, mode: "direct", url, headers}
curl -X PUT -H "Content-Type: image/png" --data-binary @photo.png "$url"
file_upload_commit {upload_id}
  -> {status: "uploaded", storage_path, import: {status: "imported", slug}}
...
search_by_image / query cross_modal -> image page slug
file_list {slug} -> storage_path
file_get {storage_path}  (or file_url)
```
