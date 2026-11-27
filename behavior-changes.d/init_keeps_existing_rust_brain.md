---
kind: fix
---
gbrain init (and gbrain init --non-interactive) with no engine flag on a brain whose config says engine "rust" now reports the existing Rust brain and leaves config.json unchanged; it never opens the Rust store. Before, plain init rewrote the config to engine "pglite" and --non-interactive stopped to ask for --url. Pass --pglite, --supabase or --url to switch engines explicitly.
