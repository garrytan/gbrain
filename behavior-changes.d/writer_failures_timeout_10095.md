---
kind: fix
---
Writer failure reports that time out on a large receipt history can be retried with a higher per-statement timeout via --timeout-ms. The default remains 5 seconds, and the next-page and drill-down commands carry the chosen timeout.
