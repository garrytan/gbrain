**Forwarding an email with only an FYI note no longer opens a "waiting on them" loop.**

### Fixed
- A forward whose own note asks nothing ("FYI, see below.") over someone else's question opened an `unanswered_outbound` loop, against the rule in docs/guides/open-loops.md that an FYI or forward without a question opens nothing. Since #8941 a forward keeps its whole body, and the loop detector counted a question mark anywhere in that body. It now reads only the note above the forward separator (Gmail's "Forwarded message" line or Apple Mail's "Begin forwarded message:"). A forward whose note does ask still opens a loop, and forwards still keep their full content.
- The same reading applies to mail sent to you: a "Thanks!" reply to someone's FYI forward counts as the reply again instead of leaving a reply-owed loop open.
- A loop that already opened this way is not closed by the upgrade. It closes when the other person replies, or with `gbrain loops drop <id>`.

<!-- behavior-change: forward_fyi_no_loop_gst2899 -->
