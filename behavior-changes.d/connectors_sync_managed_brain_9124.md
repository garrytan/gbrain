---
kind: fix
---
gbrain connectors sync <provider> run in the foreground now imports chat history on a brain whose writes go through the writer: it submits each imported page through the CLI's own write context, the way gbrain transcripts ingest already does. Before, the import was refused on such a brain and no conversations landed. If you saw that refusal, run gbrain connectors sync again in the foreground. A --background or scheduled sync and the connector_sync operation are unchanged and still refused there.
