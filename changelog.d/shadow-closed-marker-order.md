**Shadow mode now decides which stale sessions are abandoned before it reads their journals, so a child's samples written between those two steps are no longer counted twice.**

### Fixed
- The pass that settles a crashed or abandoned shadow session treats a session record more than 10 minutes old as abandoned when the session was closed or its serving process is gone. It made that decision after it read the client journals, so a child that wrote its last samples between the read and the decision had them counted from the record and from its journal (6 counted for 3 owed). The pass now decides before it reads the journals, and a session that becomes stale later waits for the next pass. The only effect is a lower, correct count; no count, reason or status text is added or renamed. One case stays: a child that is still alive when its 10-minute-old record is settled and writes after the journal read is still counted twice; that only raises the count and keeps the write check closed.

<!-- behavior-change: shadow_stale_marker_order -->
