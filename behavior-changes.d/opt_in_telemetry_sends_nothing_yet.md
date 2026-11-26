---
kind: add
---
gbrain has a new `gbrain telemetry` command for opt-in usage data, and it is off. This release sends nothing and opens no connection for it: it ships no address to send to, so `gbrain init` and `gbrain setup` do not ask about it yet. `gbrain telemetry` shows the setting and `gbrain telemetry off` deletes anything kept locally. A later release that deploys the server side turns the question on, and then nothing is sent unless you say yes.
