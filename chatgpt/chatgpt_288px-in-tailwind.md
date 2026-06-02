---
title: "288px in Tailwind"
type: note
created: 2025-12-15
updated: 2025-12-15
source: chatgpt-export
conversation_id: 6940826d-7a30-8326-9090-7e661eedd7a3
message_count: 2
tags: [chatgpt, import, code]
---
# 288px in Tailwind

> Conversation ID: 6940826d-7a30-8326-9090-7e661eedd7a3
> Created: 2025-12-15T21:49:34Z
> Updated: 2025-12-15T22:05:14Z
> Messages: 2

---

## User

288px in tailwind

---

## Assistant

In **Tailwind CSS**, 288 px corresponds to the **18 rem** spacing value on the default spacing scale. citeturn0search2

### Common Tailwind Utilities for 288 px

- **Width:**  
  ```html
  class="w-72"
  ```  
  → `width: 18rem; /* 288px */` citeturn0search2

- **Height:**  
  ```html
  class="h-72"
  ```  
  → `height: 18rem; /* 288px */` citeturn0search5

- **Both width and height (size):**  
  ```html
  class="size-72"
  ```  
  → `width: 18rem; height: 18rem; /* 288px */` citeturn0search0

### Custom Values

If you need exactly **288px** outside the default scale, use the arbitrary value syntax:

```html
class="w-[288px]"   /* for width */
class="h-[288px]"   /* for height */
```  

This works in JIT mode (default in Tailwind ≥ v3). citeturn0search1

Let me know if you want the equivalent for padding/margin.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
