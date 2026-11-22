---
kind: default
---
gbrain auth create <name> --member <id> without --scopes now mints a key with read and write only. It used to mint the grandfathered full access, admin included, so a key handed to one person could call admin tools such as get_stats and see brain-wide counts. A script that runs gbrain auth create --member and then calls an admin tool with that key now gets insufficient_scope; pass --scopes read,write,admin to mint the old full access. An explicit --scopes still wins, a token made without --member keeps the old default, and tokens that already exist are not changed.
