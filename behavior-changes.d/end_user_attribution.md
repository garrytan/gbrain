---
kind: add
---
A service credential granted the new declare_end_user scope (for example a multi-user MCP gateway in front of a shared brain) may name the person each request serves in the X-Gbrain-End-User header; that request's writes record the person and attribution reads show it as end_user (get_write_attribution, get_versions written_by and archived_by), and whoami echoes it. It is attribution only: it never changes what the request may read or write and needs no member per person. A credential without the scope that sends the header is refused before any work (insufficient_scope), and admin does not imply the scope.
