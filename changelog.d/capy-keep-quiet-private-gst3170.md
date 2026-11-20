**A conversation fact the speaker asked to keep quiet is now saved private.**

<!-- behavior-change: keep_quiet_private_gst3170 -->

### Fixed
- When someone in a conversation says "keep this quiet for now, but ...", "off the record", "don't tell anyone" or opens a sentence with "between us", the fact that restates that claim is saved private instead of at the page's visibility, so other members' credentials and unbound tokens no longer read it. The brain owner reads it exactly as before. The match is made on the conversation text, in English; the extraction prompt is unchanged, and the page's other facts keep their visibility.
