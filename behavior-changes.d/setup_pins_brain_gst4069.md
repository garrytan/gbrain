---
kind: fix
---
gbrain setup claude-code and gbrain setup codex now write the brain they set up into the MCP registration as GBRAIN_BRAIN_ID when you name one (--brain or GBRAIN_BRAIN_ID), when an earlier setup pinned one, or when the run labels people or binds the entry to a member. A session started from another directory then opens the brain that holds those members, not the brain its directory points at. A setup that labels nobody and names no brain leaves the registration unpinned, as before; re-run setup with --brain host to change a pinned brain.
