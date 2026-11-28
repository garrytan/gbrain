---
kind: fix
---
get_page with a same-page, same-view cursor from an older revision and additional window selectors now resumes at the cursor's byte position in the current revision instead of restarting at the fallback lines or bytes. The position is clamped after a shrink, and the result explains that it resumed on the current revision; it is not a snapshot of the earlier revision. A cursor alone still reports revision_changed. gbrain get now prints the window_selector note on stderr, including the warning that a window is not the whole page when include_content or content_only was set aside. Stdout still contains only the selected window.
