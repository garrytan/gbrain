**Agent and terminal text never carries a raw control character, and a printed command is whole or not printed.**

<!-- behavior-change: agent_text_controls_and_whole_commands -->

### Fixed
- The question gbrain asks when a managed checkout has no Git name and email now names the checkout by its quoted form. Before, it printed the folder name as it was, so a bell, an escape sequence or a C1 control in the name acted on the reader's terminal and could hide a private path from the HTTP path mask.
- Every message an agent or terminal reads (`why`, `user_message`, `[AGENT]` fields, notices) writes a control character other than tab (BEL, ESC, DEL, NUL, C1) as a visible three-digit octal escape such as `\033`.
- A long message is cut only between whole characters: never between the two halves of an emoji and never inside a `\NNN` escape.
- A command argument longer than 2,000 characters prints whole. Before, the printed command cut it, which named a different path.
- An argument with a NUL byte or a lone surrogate cannot be passed to any program. Such a fix keeps the exact `argv` in JSON, prints no command, moves `next` to `report` (unless a callable MCP step exists) and says in `why` which argument is wrong and why. It never echoes the value.
- A line with a length cap (an `[AGENT]` `next:` field, a decision option, a consent refusal's `if_yes` and `if_no`) prints a command whole or says "the command is too long for this line; read it from --json". It never prints a cut command.
- The identity question and the parked-effect explanation are built to fit the 2,000-character limit. When a checkout path is too long, they leave out the inline `git -C <checkout>` commands and point to the fix command, which carries the path.
- On the HTTP and MCP view, a private path right after a raw control character in a structured `argv`, `verify.argv` or `preview_argv` is masked. CLI and stdio argv stay exact.

### Blast radius
- Text that held a raw control character now shows its `\NNN` escape. Tab prints as before.
- A consent refusal's JSON `preview` has no `command` when its argv holds a NUL byte or a lone surrogate.
- `gbrain sync status` prints the rendered identity question and prints "command unavailable" instead of joining raw argv.

### Known, not in this change
- Bidirectional controls (U+202A to U+202E, U+2066 to U+2069) are not escaped, so they can still reorder what a terminal shows.
