---
kind: fix
---
get_page grep (gbrain get --grep) now treats an inner pipe as alternatives: a term such as uptime|SLA matches paragraphs holding either word, as well as the literal text, and the response lists the words in grep.alternatives. A spaced pipe (a | b, a table row) or a leading or trailing pipe is still matched literally.
