**A brain with no declared audience is now counted as shared by the people behind its MCP clients, not the number of clients.**

<!-- behavior-change: audience_counts_people_gst3180 -->

### Changed
- With no `brain.audience` declared, the shared-or-personal check counts people. Active clients bound to the same member count once, and a client bound to nobody counts by itself. The brain reads as shared at 2 members or 3 people. So one member's three bound clients no longer make the brain look shared, and two members with one client each now do. Unbound clients count one each, as before; bind them with `gbrain auth rescope --member` or declare `brain.audience`. `gbrain doctor` lists the count in `audience_reasons`, and says when the member bindings could not be read. A declared `brain.audience` wins as before.
