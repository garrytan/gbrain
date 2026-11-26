---
kind: default
---
OpenClaw skill pins now appear only in the owner's sessions (the main session, an owner-private memory audience, or a direct message from an owner sender). Group, channel and other people's direct messages get a pin only when it was added with gbrain skills pin add <id> --class owner,conversation, and relay, cron, heartbeat, webhook and subagent turns get no pins or suggestions. A skill whose frontmatter says audience: owner is never suggested or pinned outside the owner's sessions. To keep a pin in group chats, re-add it with --class owner,conversation; gbrain doctor lists each agent's conversation pins.
