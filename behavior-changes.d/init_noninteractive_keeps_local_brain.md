---
kind: fix
---
gbrain init --non-interactive on an existing PGLite brain, with no engine flag and no database URL, now keeps that brain and its database path instead of stopping to ask for --url. Pass --pglite, --supabase, --url or --prefer-postgres to choose an engine explicitly. With no config at all, --non-interactive still asks for --url and writes nothing.
