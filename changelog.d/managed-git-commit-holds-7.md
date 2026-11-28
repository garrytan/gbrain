**A folder name or page value with a bidirectional control can no longer reorder a printed command or an agent message.**

<!-- behavior-change: agent_text_bidi_controls_escaped -->

### Fixed
- The nine Unicode bidirectional embedding, override and isolate controls (U+202A to U+202E, U+2066 to U+2069) are now escaped like other control characters. Before, a checkout folder name or a page value that held one could make a terminal or chat show a printed command in a different order than the one that runs.
- A printed command writes such a character as `$'...'` with octal bytes, so it still names the exact argument. Agent fields (`why`, `user_message`, `[AGENT]` fields, notices) write it as a visible `\NNN` escape.
- An error's `message`, `suggestion` and `why` write it as a `\NNN` escape. Nothing else in that prose changes.
- An MCP step shown as text (a notice `fix:` line, a `Next:` suggestion, the CLI "call ... over MCP with" line) and a JSON error document (MCP tool errors, `--json` errors and consent refusals, the HTTP scope refusal) write it as a `\uXXXX` JSON escape. Parsing the JSON gives back the exact value, so `argv` and MCP arguments are unchanged.

### Blast radius
- Text that held one of these nine characters now shows its escape. Successful MCP result bodies and `_meta` are unchanged.
