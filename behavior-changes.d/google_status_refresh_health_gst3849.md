---
kind: fix
---
gbrain google status now counts a failed refresh probe: the JSON ok field is false and the exit code is 1 while any account's refresh fails, where it used to report ok. With --no-probe each account reports refresh_probe: unprobed instead of omitting it, so unchecked is never read as healthy. status also takes --account <email> and reports each account's client_mode and grant_generation.
