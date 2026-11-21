**New `gbrain identity` command shows who gbrain takes the brain's owner to be, and a doctor check warns when that is ambiguous.**

<!-- behavior-change: owner_identity_command_gst3216 -->

### Added
- `gbrain identity [--member <id>] [--json]` lists the owner's identifiers (the owner member's email, the account of each Google source the owner owns, linked chat ids) and the page facts about the owner belong on: the one person page whose email matches, else the owner member's page, else `memory/owner`. A name never counts, and an identifier two members claim counts for neither. It runs on the brain host only; a thin client refuses it.
- `gbrain doctor` has a new `owner_identity` check. It warns when an identifier is shared between members, when several person pages carry an owner email, or when a Google source on a brain with several people is bound to no member, and its details carry counts only, never the identifiers.
