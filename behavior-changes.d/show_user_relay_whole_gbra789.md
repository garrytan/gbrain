---
kind: fix
---
The text gbrain asks your agent to show you (the [SHOW USER] part of an [AGENT] block) is no longer cut at 1,000 characters. gbrain setup and gbrain init used to end their first-run summary mid-number ("conservative $4 / $80 / $16…"), so the closing line "Nothing needs an answer now" never arrived. The relay now carries up to 4,000 characters, and marker text inside it is still neutralised.
