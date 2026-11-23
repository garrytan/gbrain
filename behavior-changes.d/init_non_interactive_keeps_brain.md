---
kind: fix
---
gbrain init --non-interactive with no engine flag now re-runs against the brain the config file already names: a PGLite brain at its configured database_path, or a Postgres brain at its configured database_url. Before, both stopped with "--non-interactive requires --url". An environment DATABASE_URL or GBRAIN_DATABASE_URL still wins, explicit engine flags still choose the engine, and with no config the command still asks for --url.
