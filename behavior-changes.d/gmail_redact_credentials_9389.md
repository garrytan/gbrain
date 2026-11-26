---
kind: add
---
New opt-in setting google.gmail.redact_credentials (default false). When true, Gmail sync replaces labelled one-time codes, magic sign-in and password-reset links, credential-shaped strings and labelled temporary passwords in message bodies with placeholders such as [redacted:otp] before the text is saved, chunked, indexed or versioned, and every re-sync writes the same placeholders. Subjects, pages synced before it was turned on and older page versions are unchanged.
