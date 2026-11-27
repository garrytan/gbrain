---
kind: fix
---
A checkout folder name or page value that holds a Unicode bidirectional embedding, override or isolate control (U+202A to U+202E, U+2066 to U+2069) can no longer make a terminal or chat show a printed command in a different order than the one that runs. Printed commands write such a character as octal bytes inside $'...', so they still name the exact argument. Agent messages, notices and error message, suggestion and why fields show it as a visible octal escape such as \342\200\256. MCP steps shown as text and JSON error documents write it as a \u202e JSON escape, which parses back to the exact value, so argv and MCP arguments are unchanged. Successful MCP result bodies are unchanged.
