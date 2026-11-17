---
kind: fix
---
An attached file is no longer overwritten when you upload a different file with the same name to the same page. gbrain files upload, gbrain files upload-raw and the file_upload tool keep the first file and its record exactly as they were and store the new one beside it, with the first 12 characters of its content hash in front of the filename, for example notes/acme-example/1a2b3c4d5e6f-contract.pdf. The upload reports where it went; file_upload also returns kept_original. Uploading the same bytes again is still a no-op, and a record whose bytes are missing from storage is still repaired in place. If you meant to replace a file, upload the new one under its own name and update the page to point at it.
