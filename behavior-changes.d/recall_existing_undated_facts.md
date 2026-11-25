---
kind: fix
---
General recall can read an existing fact with an unknown event date and keeps that date null. A window over event time only matches facts with a known event date. Fact creation and database migrations are unchanged.
