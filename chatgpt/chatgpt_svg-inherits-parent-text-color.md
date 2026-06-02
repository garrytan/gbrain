---
title: "SVG inherits parent text color"
type: note
created: 2023-02-27
updated: 2023-02-27
source: chatgpt-export
conversation_id: 38ed8017-36a0-46fa-bc8a-78af118d4e77
message_count: 2
tags: [chatgpt, import, code]
---
# SVG inherits parent text color

> Conversation ID: 38ed8017-36a0-46fa-bc8a-78af118d4e77
> Created: 2023-02-27T01:32:45Z
> Updated: 2023-02-27T01:32:45Z
> Messages: 2

---

## User

i want an svg to inherit the text color of its parent

---

## Assistant

To make an SVG element inherit the text color of its parent, you can use the `currentColor` keyword in the SVG code. 

For example, if you have an SVG element that contains text, you can set the `fill` property to `currentColor`. This will make the text color of the SVG element inherit the color of its parent element.

Here is an example code snippet:

```
<div style="color: red;">
  <svg>
    <text fill="currentColor">Hello World</text>
  </svg>
</div>
```

In this example, the `div` element has a text color of red. The `text` element inside the SVG inherits this color using the `currentColor` keyword. So the text inside the SVG will also be red.

Note that the `currentColor` keyword only works for properties that accept color values, such as `fill`, `stroke`, `stop-color`, etc.
