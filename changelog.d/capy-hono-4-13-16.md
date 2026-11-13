---
important: security
---

**The MCP server's HTTP framework, Hono, moves to a release that fixes five published advisories.**

### Security
- The `hono` override (Hono comes in through the MCP SDK's HTTP transport) moves from `^4.13.11` to `^4.13.16`, now resolving 4.13.18. Hono 4.13.13 had five advisories, all fixed in 4.13.16: GHSA-3gg2-335m-rxc6 (the `css` helper could let HTML through when a closing tag was split between the template and a value), GHSA-46wx-v44x-9hh2 (`csrf()` did not check requests sent by hyperlink auditing), GHSA-h7mg-cq63-vhpq (the RegExpRouter could skip wildcard middleware for some routes and for paths with an encoded line terminator), GHSA-4h7h-rv7c-7m2v (`validator('form')` skipped validation for `multipart/form-data` requests with extra parameters) and GHSA-4m76-xfj5-7975 (`mount()` could forward a path that bypassed middleware scoped inside the mount prefix). Four are rated medium and one low. `bun audit` and the OSV scan now report nothing.
