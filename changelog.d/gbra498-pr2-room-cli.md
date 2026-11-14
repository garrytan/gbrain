### Name the room on the CLI, and think answers and writes carry room marks too

**`--room <list>` now works on every gbrain operation command, and `think`, `put_page` and `remember` answers are marked for the room like reads are.** A harness that runs gbrain as a command, or a person checking what a group chat could see, gets the same marks an MCP caller gets, and the agent writing into a room can tell which parts of a synthesized answer came from pages the room cannot read.

- `gbrain <command> --room alice-example,group:team-a` prints exactly what the command prints without it. With `--json` every item carries `room_access` and the document carries `_meta.room` (a list becomes `{ results, _meta }`); without it stderr names what the room cannot read. The local CLI marks the brain owner's view, or the member `--as` names; with no owner set, every item is unknown and the notice says to run `gbrain access owner set`.
- A trailing `--room` with no value is never dropped. The command runs, every item is marked unknown (`invalid`), the degraded stamp shows and it exits 0.
- It works through a running `gbrain serve` that owns a PGLite brain (the owner marks the answer) and on a thin client (sent as `_meta.room`). A host or owner that predates room marks leaves every item unknown (`not_supported`).
- A `think` answer is marked at the strictest class of everything its synthesis retrieved or was shown (the anchor and the graph pages its prompt names, each under its own source); an answer built partly from takes or a calibration profile, or with no recorded evidence, is unknown. `put_page` and `remember` mark the page or fact they wrote and are never stamped degraded for it, so a committed write never reads as one to retry.
- The shipped access-policy and agent templates now say how an agent acts on its owner's own turn in a group chat (at the owner's scope, written for the room, with truly private material offered in a private chat and never a refusal; everyone else is answered at the group's level) and that a send the principal asks for in their own verified message goes out as asked, with no approval phrase or draft-first step. Existing installs keep their own files.
- Guide: [docs/guides/rooms.md](docs/guides/rooms.md).

<!-- behavior-change: room_cli_think_writes_gst2639 -->
<!-- behavior-change: owner_turn_sends_templates_gst2656 -->
