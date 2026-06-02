---
title: "Untitled Conversation 6954"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: f0caa754-eddd-4619-b817-052b31a3ee03
message_count: 2
tags: [chatgpt, import]
---
# Untitled Conversation 6954

> Conversation ID: f0caa754-eddd-4619-b817-052b31a3ee03
> Created: 2022-12-13T19:48:00Z
> Updated: 2022-12-13T19:48:00Z
> Messages: 2

---

## User

The following code works inside the devtools console but not in my chrome extension content script

window._sharedData.config.viewer.id;



---

## Assistant

It is likely that the code is not working in your Chrome extension content script because the `_sharedData` variable is not available in the content script's global scope. In a content script, you will only have access to variables that are defined in the page that the content script is running on, as well as any APIs provided by the Chrome extension system.


