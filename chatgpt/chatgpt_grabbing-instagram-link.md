---
title: "Grabbing Instagram Link."
type: note
created: 2023-04-02
updated: 2023-04-02
source: chatgpt-export
conversation_id: 4aea2c2f-3721-4f0d-a8c2-1bd510981df9
message_count: 2
tags: [chatgpt, import, code]
---
# Grabbing Instagram Link.

> Conversation ID: 4aea2c2f-3721-4f0d-a8c2-1bd510981df9
> Created: 2023-04-02T17:13:10Z
> Updated: 2023-04-02T17:13:19Z
> Messages: 2

---

## User

//*[@data-type='instagram']
modify this to grab the link value of the item

---

## Assistant

Assuming that this XPath expression is targeting an HTML element with a `data-type` attribute set to `'instagram'`, you can modify it to grab the value of the `href` attribute (which is typically used to store links) of that element by appending `/@href` to the end of the expression, like this:

```
//*[@data-type='instagram']/@href
```

This modified XPath expression should select the `href` attribute of the element that matches the `[data-type='instagram']` condition, returning the value of the link.
