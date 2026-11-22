---
kind: fix
---
The dream summary page for a date now keeps the links a previous synthesize run wrote that day, as long as each linked page still exists, instead of keeping only the latest run's pages. "Pages written" still counts the latest run, and a new "Pages from earlier runs today" line counts the pages kept from earlier runs. The earlier runs' pages are read from the previous summary's list, which holds at most 20 links, so after a run that wrote more than 20 pages the kept count is a lower bound.
