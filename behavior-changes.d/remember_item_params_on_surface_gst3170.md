---
kind: fix
---
A client on a narrower MCP tool surface, such as the starter surface, can no longer pass a remember parameter that its surface hides by putting it inside an items entry. Such a call is refused with param_not_on_surface, the same as the parameter at the top level. Full-surface clients and the local CLI are unchanged.
