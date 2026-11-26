---
kind: fix
---
gbrain doctor now refuses a missing brain in three more cases. A brain folder with no PG_VERSION that still holds a leftover .gbrain-lock whose metadata cannot be read is refused as brain_missing; before, the leftover lock read as held and doctor built an empty brain. When the folder is moved or unmounted while doctor waits for the datastore's lock, doctor checks again once it holds the lock, refuses, releases the lock and creates no datastore; the empty .gbrain-owner.lock file beside the folder can still be left behind. With --alert (and --alert --json), a missing brain is reported with the alert contract: exit 17, alert level act, and one brain_missing item, so a heartbeat pages on it; without --alert, doctor still exits 1 with the same brain_missing error.
