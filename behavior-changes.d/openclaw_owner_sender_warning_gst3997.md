---
kind: action
---
`gbrain doctor` and `gbrain setup openclaw` now warn (`skill_resolver_owner_unverified`) when an OpenClaw agent with the skill resolver live has no owner sender set and OpenClaw puts every direct message on its main session (`session.dmScope` main, OpenClaw's default). Without a memory audience from OpenClaw, anyone who messages such an agent directly gets the owner's pins and owner-only skill suggestions. Nothing changes on its own: set your sender id with `gbrain setup openclaw --skill-loading resolve --agent <id> --owner-sender <your sender id>`, or add `--require-owner-sender` to treat the main session as another person's DM until one is set. Doctor stays quiet when every recent turn carried OpenClaw's memory audience.
