**A keyless `gbrain init` no longer stops because an unrelated short API key is set.**

### Fixed
- `gbrain init` checks for near-miss key names, such as `OPENAPI_API_KEY` for `OPENAI_API_KEY`, and stops when it finds one. Any short name is within 3 edits of another, so keys for other services, such as `EXA_API_KEY`, counted as typos of a short provider key and a keyless install exited 1 with "No embedding provider configured." A near-miss must now keep at least half of the provider name. `OPENAPI_API_KEY`, `VOYAG_API_KEY` and one-letter slips in short names are still caught.
- Tests: two fake engines get the typed members that the connect path and the query path now call, and the shared projection-window text casts its `ord` column to a number, as the engine copy already did.
