**`gbrain extract all` no longer stops on a page over 1 MiB, on every engine.**

### Fixed
- `gbrain extract all` (the file walk) exited 1 when the brain held a page stored in segments (a body over the 1 MiB single-string limit): its links step recorded each page's dated link evidence by reading the stored body as one string, which a segmented page refuses. For a segmented page that evidence is now read from its stored segments block by block, as `extract all --source db` already does, so every page extracts on PGLite, Postgres and Rust. Pages that are not segmented are extracted exactly as before.
