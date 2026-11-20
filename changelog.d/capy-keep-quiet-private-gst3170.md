**A conversation fact the speaker asked to keep quiet is now saved private.**

<!-- behavior-change: keep_quiet_private_gst3170 -->

### Fixed
- When someone in a conversation says "keep this quiet for now, but ...", "off the record", "don't tell anyone" or opens a sentence with "between us,", the fact that restates that claim is saved private instead of shared, so other members' credentials and unbound tokens no longer read it. The brain owner reads it exactly as before. The match is made on that window's messages, in English and never on an assistant's reply; the extraction prompt is unchanged, and the page's other facts keep their visibility. A claim that was forgotten or purged earlier stays out, as before. A cue in one extraction window does not reach a fact extracted from a neighbouring window.
