---
kind: breaking
exception: data-loss
---
Managed file repairs (gbrain repair rows-behind, file-drift, frontmatter, slug-conflicts, fence repair and local-edit adoption) now run the write gate a sync of the same file runs, with the file's path, so they keep a page's instruction_like flag or quarantine instead of stripping it, and an owner allow rule scoped to that path holds during the repair. Under write_gate.external_mode=reject, a repair of external instruction-like content now refuses with write_gate_rejected, the way sync already holds that file, instead of publishing it. If a repair refuses this way and you trust the file, allow it with gbrain trust allow --source <id> --uri-prefix <path>, or edit the file, then preview and apply the repair again; nothing was written.
