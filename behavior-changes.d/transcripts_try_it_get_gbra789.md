---
kind: fix
---
gbrain transcripts ingest now ends with "try it: gbrain get <slug>" naming the page it just wrote (with --source-id when the import went to a source other than default). It used to suggest gbrain query "<slug>", a keyword search for the slug string that found nothing useful.
