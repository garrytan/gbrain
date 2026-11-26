**OpenClaw group chats stop seeing a pinned skill as soon as it is marked owner-only, and front matter that is never closed can no longer make an owner-only skill public.**

### Fixed
- After a skill catalog is rebuilt (a skill edit, or `gbrain skills index build`), OpenClaw conversations get no pins until the plugin's background refresh renders them from the new build. A pin whose skill was just marked `audience: owner` never reaches a group in between, and a refresh that fails is tried again on a later turn.
- A `SKILL.md` whose front matter is never closed, quotes the `audience` key or spells it `Audience` is kept to the owner instead of being indexed with no audience.
