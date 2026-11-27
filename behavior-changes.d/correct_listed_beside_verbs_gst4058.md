---
kind: fix
---
Agent connections that list only the memory verbs on a wider tool surface, which is Claude Code's default registration (gbrain serve --surface starter --advertise verbs), now also list correct, the tool that saves a standing rule the user states and fixes the fact it corrects. It appears only where the connection can already call it; nothing new becomes callable, and gbrain serve --surface verbs still lists and accepts exactly the seven memory verbs. correct's description now tells agents to call it only for a correction or a standing rule, and to call remember for anything else the user asks them to save.
