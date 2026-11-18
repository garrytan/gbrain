---
important: security
---
**An agent job a starter client submits is now confined to the starter tool surface, so its tool calls cannot read soft-deleted pages either.**

<!-- behavior-change: agent_job_surface_confined_9669 -->

### Fixed
- An agent job (`submit_agent`) ran its brain tools on the full tool registry, whatever surface its submitter was served. So a starter client with the `agent` scope could have a job call `get_page` with `include_deleted` and read a soft-deleted page that its own direct calls are refused (#9669). Each new job now records the surface of the connection that submitted it, and every tool call the job makes is refused exactly as MCP dispatch refuses that connection. A hidden parameter gets `param_not_on_surface`, with the same reviewed exceptions, and a hidden tool gets `unknown_tool`. The job's tool call fails with that refusal and nothing runs. Jobs from full-surface clients and local jobs are unchanged. Jobs already queued when you upgrade keep the full surface they were accepted under until they finish.
- `request_tools {tools}` on a narrower surface describes only the parameters that surface may pass, instead of every registry parameter.
- The `list_pages` `listing_truncated` fix now carries `slug_prefix`, `where` and `source_ids`, so the next-page call continues the filtered listing instead of the unfiltered one.
