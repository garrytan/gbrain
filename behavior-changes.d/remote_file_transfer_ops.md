---
kind: add
---
Remote MCP callers with the new files scope (implied by admin) can now move file bytes: file_upload_begin, file_upload_part, file_upload_commit and file_upload_abort upload a file into the configured storage backend (direct to an S3-compatible bucket through a short-lived signed PUT, or inline in base64 parts), optionally importing an image as a searchable image page; file_get returns a stored file (images as an MCP image block), and file_list and file_url are no longer limited to the local stdio server. The path-based file_upload stays local-only. Grant files rather than admin to a client that only needs to move files: admin also opens job control and schema changes.
