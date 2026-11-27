---
kind: fix
---
gbrain dream --input <file> still runs the synthesize phase on its own. If you also pass --phase, include --phase synthesize: a phase list without it, or --input with no file, now exits 2 with a usage error instead of ignoring the file and running the other phases over their usual inputs.
