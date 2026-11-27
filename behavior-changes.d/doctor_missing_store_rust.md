---
kind: fix
---
gbrain doctor no longer creates an empty store when a Rust-engine brain's store folder is missing. When the config names a Rust store directory that is not there, or a folder with neither its FORMAT file nor its record file (an unmounted drive or a moved folder), every doctor run that opens the database now stops before it connects, exits 1 and prints the brain_missing error with reason missing_brain, as PGLite brains already do. Before, doctor created a new empty store at that path and reported a score of 75. doctor --fast never opens the database and runs as before. Other commands that open a Rust brain refuse the same way (read_commands_missing_store_rust).
