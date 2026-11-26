---
kind: fix
---
gbrain setup now exits 1 when an import you asked for with --notes, --docs or --transcripts fails, and prints one line on stderr naming the folder, the error and the import command to run again. It used to exit 0 with the failure only inside its report. A --docs or --transcripts import that could not run because the company source could not be set up counts as failed too. An unreadable folder is now a failed import ("cannot read <folder>: EACCES") instead of "import 0 file(s)". The harness wiring and every other step that finished stay in place, and --json still prints one document whose brain_layout names the failed import.
