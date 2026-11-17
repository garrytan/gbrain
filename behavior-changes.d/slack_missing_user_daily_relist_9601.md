---
kind: fix
---
Slack sync now looks a user up again when the last users listing lacked them and that listing is more than a day old, instead of waiting up to seven days. A new member's name replaces their raw id on day pages written after the next sync. A Slack Connect user from another workspace never appears in the listing, so a workspace with shared channels may make one extra full users listing a day.
