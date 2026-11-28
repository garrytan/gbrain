**Shadow mode no longer counts a stale session's samples twice when its child writes them while the cleanup pass runs.**

### Fixed
- The pass that settles a crashed or abandoned shadow session treats a session record more than 10 minutes old as abandoned when the session was closed or its serving process is gone. It made that decision after it read the client journals, so a child that wrote its last samples between those two steps had them counted from the record and from its journal (6 counted for 3 owed). The pass now decides before it reads the journals, and a session that turns stale later waits for the next pass. The only effect is a lower, correct count; no count, reason or status text is added or renamed.

<!-- behavior-change: shadow_stale_marker_order -->
