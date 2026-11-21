---
kind: fix
---
An agent job submitted with `submit_agent` now runs its tools on the tool surface of the connection that submitted it. A starter client's job can no longer pass a parameter or call a tool that the starter surface leaves out: a hidden parameter is refused with `param_not_on_surface` (the same reviewed exceptions as direct calls apply), and a hidden tool with `unknown_tool`. The refused tool call fails, and the job sees why. Jobs from full-surface clients and local jobs are unchanged, and jobs already queued at upgrade keep the full surface until they finish. `request_tools {tools}` on starter now lists only the parameters starter may pass, and the `list_pages` next-page fix keeps `slug_prefix`, `where` and `source_ids`.
