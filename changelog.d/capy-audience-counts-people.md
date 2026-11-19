**A brain with no declared audience is now counted as shared by the people behind its MCP clients, not the number of clients.**

<!-- behavior-change: audience_counts_people_gst3180 -->

### Changed
- With no `brain.audience` declared, the shared-or-personal check counts people. Active clients bound to the same member count once, and a client bound to nobody counts by itself. The brain reads as shared at 2 members or 3 people. One person using three clients no longer makes their brain look shared, and two members, each with one client, now do. `gbrain doctor` lists the count in `audience_reasons`. A declared `brain.audience` wins as before.
