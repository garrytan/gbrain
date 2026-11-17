---
kind: fix
---
A sync that read a page's change reason from a gbrain-reason commit trailer, then saved the page after a fact purge removed that text, used to store the purged text in the page's history as the reason for the change. The save now checks for the purge when it writes the history row and stores no reason instead; the page content still imports, and other files' reasons from the same commit are kept. Nothing to do. Reasons already stored before this release are not changed.
