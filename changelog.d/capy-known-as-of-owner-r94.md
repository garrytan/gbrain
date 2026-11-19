**Reading a page as it was recorded (known_as_of) over remote MCP now shows the brain owner's own agents the private history the owner can read, instead of only what was ever world-visible.**

<!-- behavior-change: known_as_of_owner_history_gst3252 -->

### Fixed
- `get_page` and `get_versions` with `known_as_of` apply the same visibility rule for a token bound to the brain owner as its current-time `get_page`: private pages' earlier editions, and the private rows of a page's Facts fence, now come back to the owner's remote callers. An edition whose own `readable_by` left the owner out stays hidden, as `get_page as_of` judges a stored edition, and history from an earlier page that once held the slug keeps the world-only rule. Another member and an unbound token read exactly what they read before. (GST-3252)
