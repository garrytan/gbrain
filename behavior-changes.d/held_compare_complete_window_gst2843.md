---
kind: fix
---
A gbrain repair file-drift --held dry run (a comparison, or a --prefer preview) now reports complete: false while held pages remain past its window, and details.window.next_command names the command for the next window. Before, complete was true after every window, even with thousands of held pages left. Applies keep the old meaning: every item of the approved window was attempted.
