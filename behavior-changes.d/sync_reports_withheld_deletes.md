---
kind: fix
---
When a managed gbrain sync withholds deletes because they cross the 50% mass-delete valve, sync.max_deletes or sync.max_delete_ratio, gbrain sync now prints a one-line notice naming the withheld count, the cap that tripped and the next steps, and carries a deletes_withheld object on --json sync envelopes. Later sync runs while the same set remains withheld, including idle up-to-date runs, repeat the still-withheld notice (watch mode prints it once, when the set first appears). Before, the sync run printed only -0 soft-deleted (and then Already up to date.) with no warning unless you separately ran gbrain sync status. Exit codes, sync_status and delete withholding behavior are unchanged.
