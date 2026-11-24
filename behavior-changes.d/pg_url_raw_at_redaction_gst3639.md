---
kind: fix
---
Database URLs whose password contains a raw, unencoded @ are now redacted whole in gbrain's output. Before this release, config get database_url, engine status --json, doctor, and the init, db-repair and migrate-embeddings notes cut the password at its first @ and printed the rest of it after the *** marker. If your database password contains a raw @ and you have shared that output, the part of the password after its first @ may have been visible there.
