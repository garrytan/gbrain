---
kind: fix
---
A remote caller (MCP, HTTP or a thin client) that reads a page by a name another page also answers to now gets the same answer whether a page it may not see holds that name or no page does: the other page, when the caller may see it. Before, the two cases answered differently. Reads on the brain's own machine and pages the caller may see are unchanged.
