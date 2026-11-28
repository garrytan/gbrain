---
kind: fix
---
`gbrain config get <key>` on a write switch, a preparation budget or a terminal-failure threshold that nothing sets now prints the value in effect and exits 0, with its source on stderr (the built-in default, or the switch's environment variable when that is set). Before, it printed "Config key not found" and exited 1, so a script could not read a default such as persistence.single_consumer. A known key with no built-in default still exits 1, and an unknown key is unchanged.
