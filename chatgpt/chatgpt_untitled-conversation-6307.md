---
title: "Untitled Conversation 6307"
type: note
created: 2022-12-15
updated: 2022-12-15
source: chatgpt-export
conversation_id: a7cee6b5-cb9d-4fff-b4e9-57bf80baf6b2
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6307

> Conversation ID: a7cee6b5-cb9d-4fff-b4e9-57bf80baf6b2
> Created: 2022-12-15T17:49:59Z
> Updated: 2022-12-15T17:49:59Z
> Messages: 2

---

## User

document.documentElement.setAttribute("data-jovie-extension-installed", "true");

this adds elemts to the html root, i want to add it to the body element

---

## Assistant

To add an attribute to the `body` element, you can use the `setAttribute()` method on the `body` element itself, like this:

```
document.body.setAttribute("data-jovie-extension-installed", "true");
```

Alternatively, you could use the `classList` property to add a class to the `body` element, like this:

```
document.body.classList.add("jovie-extension-installed");
```

This would add the class `jovie-extension-installed` to the `body` element, which you could then style in your CSS.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
