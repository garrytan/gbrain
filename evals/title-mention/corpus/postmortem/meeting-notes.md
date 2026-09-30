---
title: "Meeting Notes"
type: note
---

Attendees: Alice Example, Jack Example, Carol Example, Karen Example. Agenda: October release problems and next steps. Jack summarized how the order service could not roll back after a schema migration dropped a column, and how restoring it from a snapshot took 70 minutes. Carol argued that migrations should run as a separate gated stage after health checks. Alice asked whether the revert path in the pipeline had ever been rehearsed; the answer was no. Decisions: adopt expand-and-contract migrations for all services, add a staging rehearsal to the release checklist, and block same-release column drops in the pipeline. Karen mentioned that paging noise during the outage delayed acknowledgement by six minutes. Action items: Jack drafts the migration guideline by Friday, Carol updates the pipeline stages, and Alice schedules a rehearsal for the next release. Next meeting: two weeks from today in the Harbor Street conference room.
