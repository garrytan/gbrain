**Remote agents can upload files, import images and get stored files back over MCP.**

<!-- behavior-change: remote_file_transfer_ops -->

### Added
- `file_upload_begin` / `file_upload_part` / `file_upload_commit` / `file_upload_abort`: a byte-based upload lane for remote MCP callers. A backend that signs URLs (S3-compatible, including Google Cloud Storage's XML API with HMAC keys) answers with a 15-minute presigned PUT, so the bytes go straight to the bucket; any other backend takes base64 parts. Commit verifies size, SHA-256 and the real type, stores the file at the `file_upload` layout through the same recording path, and with `import: true` turns an image into a searchable image page (visual embedding + OCR) linked to the page it was attached to.
- `file_get`: a stored file's bytes, returned as an MCP image block for png/jpeg/gif/webp so the model sees the image.
- `StorageBackend.createUploadUrl` (optional; S3 implements it).

### Changed
- `file_list` and `file_url` are callable by remote admin clients, not only over local stdio. `file_upload` (server-side path) stays local-only.
