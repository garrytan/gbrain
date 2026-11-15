**A second folder of notes (say, your company's beside your own) shows up in search without Git and without guessing why it doesn't.**

### Changed
- On a brain only you use, a source you add without `--federated` or `--no-federated` joins default search, so `gbrain query` finds its pages right away. On a shared brain it stays out, and `gbrain sources add` and `gbrain sync --source <id>` say so with a `source_not_in_default_search` notice whose fix is `gbrain sources federate <id>` (also under `notices` in `--json`). Sources you already have keep their setting.
- `gbrain sources add <id> --path <folder>` accepts a plain folder that is not in a git repository, without `--force`, and says that git history is off for it. A git repository with nothing committed is still refused. `gbrain sources inspect` on a plain folder now points at `sources add`.
- `gbrain setup codex` lists the provider key names (`OPENAI_API_KEY`, `VOYAGE_API_KEY` and the rest) under `env_vars`, so Codex passes keys you already exported to gbrain and search stays semantic. Only names are written.
- The "sole non-default source ... routing to 'default'" line no longer prints on every command when that source is already in default search.
- `gbrain sources federate` on a keyless brain says embedding is off instead of telling you to run `gbrain embed --stale`, and `sources --help` and `pages --help` no longer show an old version in their header.
- README: the voice line points at agent-voice (the Twilio recipe is deprecated), says how voice notes and chat transcripts get in today, and shows how to add a second folder.

<!-- behavior-change: new_sources_join_default_search_gst2732 -->
<!-- behavior-change: plain_folder_sources_gst2732 -->
