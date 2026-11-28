---
kind: fix
---
A meeting summary whose only clock times are calendar fields (start, end, time or date lines such as a start time of 08:15 or a 08:15 to 08:45 time range, in English or Chinese) no longer reads as a transcript. Doctor's conversation_format_coverage used to count such a page as a parser miss, so the unmatched count can go down after you upgrade. Pages with a transcript heading, a raw_transcript sidecar, or timestamped speech lines are judged as before.
