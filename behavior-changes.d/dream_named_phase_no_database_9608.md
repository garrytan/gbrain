---
kind: fix
---
gbrain dream --input <file>, or gbrain dream --phase <name>, run with no database connection used to exit 0 after the phase it was asked to run skipped. Now a phase you named, or that --input implies, that skips for want of a database ends the command with database_error and exit 1 (the error envelope under --json). Other named phases that need no database still run first, and their report is not printed when the refusal fires. A plain gbrain dream names no phase and still exits 0 when it can only run the filesystem phases. A script that runs dream with --input or --phase and checks the exit code now sees the failure; fix the database connection (gbrain doctor --json names the cause) and run it again.
