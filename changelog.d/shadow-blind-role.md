**The Rust engine shadow now says when the database role cannot see other sessions, and how to fix it.**

### Added
- A Postgres brain whose database role is neither a superuser nor able to use `pg_read_all_stats` cannot prove that a sampled read stayed fresh, so its shadow clears no privacy sample and no recall score. `gbrain engine shadow status`, the shadow report and `gbrain engine swap --plan` (criterion 3) now name that reason: "freshness token blind: role lacks pg_read_all_stats".
- A new `gbrain doctor` check, `shadow_freshness_token`, warns with the fix for your role and server: `GRANT pg_read_all_stats TO <role> WITH INHERIT TRUE;` on PostgreSQL 16 and later, and the plain GRANT before 16 (a NOINHERIT role there also needs `ALTER ROLE <role> INHERIT;`). It says nothing on PGLite, with shadow mode off, for a mounted brain or for a remote caller.
- Nothing changes unless shadow mode is on for a Postgres brain. Status, report and the swap plan then open one extra short database connection to ask the server which role it is.
