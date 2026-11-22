**Fixed: `gbrain init --non-interactive` re-runs against the brain your config already names instead of stopping with "--non-interactive requires --url".**

### Fixed
- With no engine flag, `gbrain init --non-interactive` now keeps a configured PGLite brain (its own path) or a configured Postgres brain (its own URL). A `DATABASE_URL` or `GBRAIN_DATABASE_URL` in the environment still takes precedence, and `--pglite`, `--supabase`, `--url` and `--prefer-postgres` still choose the engine. With no config at all, it still asks for `--url`.

<!-- behavior-change: init_non_interactive_keeps_brain -->
