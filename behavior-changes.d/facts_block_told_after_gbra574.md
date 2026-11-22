---
kind: add
---
When a query names one date, each fact row in the facts block now says whether it was told after that date. A fact said after the date ends its header with "; told after DATE", for example [observed 2025-06-30; valid 2025-02-15 to unknown; told after 2025-04-01], and a fact whose saying date is unknown ends it with "; learn date unknown", so neither reads as known on that day. A question that names no date, or several, gets the headers it got before. Dates are read by the same fixed English grammar gbrain uses for time ranges in queries.
