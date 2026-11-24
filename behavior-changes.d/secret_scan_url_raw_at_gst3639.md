---
kind: fix
---
The secret scanner now redacts the whole password in a database or https URL when the password contains a raw, unencoded @. Before this release, it cut the password at its first @, so the rest of the password stayed visible after the redaction marker in the text gbrain redacts with it, such as search output and rendered transcripts. Such a finding also gets a new fingerprint. An allow entry pinned to the old fingerprint stops matching, and the scanner reports the new one to allow.
