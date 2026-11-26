---
kind: fix
---
gbrain transcripts ingest now ends with "try it: gbrain get <slug> --source-id <source>" naming the page it just wrote and the source it went to, so a shell pinned to another source still opens it. It used to suggest gbrain query "<slug>", a keyword search for the slug string that found nothing useful.
