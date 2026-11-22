---
kind: fix
---
gbrain doctor --only <check> on a check that needs no database (for example skill_resolver) now reports "No finding" at info level when the check has nothing to say, with no connection row. Before, it warned that the database checks stopped early and pointed at a connection that was never tried. A connection that really failed still reports the stop and keeps its connection row.
