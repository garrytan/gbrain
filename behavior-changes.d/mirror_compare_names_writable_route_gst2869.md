---
kind: fix
---
On a read-only mirror source, gbrain repair file-drift --held without --prefer no longer names a --prefer file (or --prefer database) preview for a page that differs from its file or a held deleted page whose file differs, in the page's why or in next_actions. Those previews read every mirror page as database-only and found nothing. The comparison keeps each page's verdict and evidence and says the page stays held until the user makes the source writable again with gbrain sources mirror-writable <id>.
