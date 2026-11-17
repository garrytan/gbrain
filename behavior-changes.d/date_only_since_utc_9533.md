---
kind: fix
---
A date-only since now starts at UTC midnight on search, query and image query, the way a date-only until already ends at UTC midnight. A brain whose database timezone isn't UTC can gain or lose rows dated within that offset of midnight. On a UTC database nothing changes, and a since given as a timestamp or a relative duration is read as before.
