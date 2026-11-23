**Fixed: `gbrain engine swap --plan` marks a service definition it cannot read as unreadable instead of listing it as setting no engine variables.**

### Fixed
- The swap preview lists launchd and systemd service definitions that mention gbrain and the engine-selecting variables each one sets. A file it could not read was listed as setting none, which looked like a clean route. It is now marked `unread: "read_failed"` in the JSON plan and "unreadable, names unknown" in the text plan.
