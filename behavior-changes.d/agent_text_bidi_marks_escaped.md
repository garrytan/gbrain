---
kind: fix
---
The left-to-right mark (U+200E), the right-to-left mark (U+200F) and the Arabic letter mark (U+061C) are now escaped in agent and terminal text, like the other bidirectional controls. Before, a checkout folder name or page value that held one could move the slashes, digits and punctuation near it on screen, so a printed path or command could look different from the one that runs. Printed commands write such a mark as octal bytes inside $'...', so they still name the exact argument. Agent messages, notices and error message, suggestion and why fields show it as a visible octal escape such as \342\200\217. MCP steps shown as text and JSON error documents write it as a \u200f JSON escape, which parses back to the exact value, so argv and MCP arguments are unchanged.
