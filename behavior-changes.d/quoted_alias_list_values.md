---
kind: fix
---
Quoted alias fields now keep commas, semicolons, slashes and the word or inside the declared name. This avoids deriving an extra name from part of a quoted value. The next gbrain extract --stale refreshes derived aliases and mention links from the earlier grammar without provider calls; explicit frontmatter aliases stay intact.
