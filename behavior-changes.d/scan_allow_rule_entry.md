---
kind: add
---
A .gbrain-scan-allow line of the form path:<glob> pattern:<rule> now allows only that secret-scan rule in the files the glob matches, so a rule that keeps flagging harmless values (for example jwt on newsletter unsubscribe links) can be quieted without turning off every other rule for those files. Existing fingerprint and path-glob lines work as before. A line that starts with pattern:, or with path: and contains a space, is read only as a rule entry: if it is malformed or names an unknown rule it allows nothing, and the push refusal, gbrain git scan and bootstrap verify name it. A bare path: line with no space is still a path glob, and gbrain git scan now warns about it.
