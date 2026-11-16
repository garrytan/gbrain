---
kind: fix
---
gbrain serve --http no longer counts a request refused for a missing or wrong bearer token as activity. Idle upkeep waits for a quiet interval, and requests anyone could send without a token used to reset that interval, so upkeep might never run. Authenticated requests, including pings, still count as before.
