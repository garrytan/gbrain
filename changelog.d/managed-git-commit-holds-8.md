**The three Unicode direction marks are now escaped in agent and terminal text, like the other direction characters.**

<!-- behavior-change: agent_text_bidi_marks_escaped -->

### Fixed
- The left-to-right mark (U+200E), the right-to-left mark (U+200F) and the Arabic letter mark (U+061C) are now escaped wherever the other bidirectional controls are. Before, a checkout folder name or a page value that held one could move the slashes, digits and punctuation near it on screen, so a printed path or command could look different from the one that runs.
- A printed command writes such a mark as `$'...'` with octal bytes and still names the exact argument. Agent fields, notices and an error's `message`, `suggestion` and `why` show it as a visible `\NNN` escape. MCP steps shown as text and JSON error documents write it as a `\uXXXX` JSON escape, which parses back to the exact value.

### Blast radius
- Text that held one of these three marks now shows its escape. JSON `argv`, MCP arguments, successful MCP result bodies and `_meta` are unchanged.
