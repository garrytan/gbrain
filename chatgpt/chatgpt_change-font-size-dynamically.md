---
title: "Change Font Size Dynamically."
type: note
created: 2023-05-07
updated: 2023-05-07
source: chatgpt-export
conversation_id: f58c56c7-ccd2-4c80-a147-4ec40e1dbc32
message_count: 2
tags: [chatgpt, import, code]
---
# Change Font Size Dynamically.

> Conversation ID: f58c56c7-ccd2-4c80-a147-4ec40e1dbc32
> Created: 2023-05-07T00:32:56Z
> Updated: 2023-05-07T00:33:06Z
> Messages: 2

---

## User

<template>
  <div
    class="flex items-center justify-center rounded-md bg-indigo-300 p-1 dark:bg-jovieDark-400"
    :style="{ height: `${height}px`, width: `${height}px` }">
    <span class="items-center text-xs text-white">{{ firstLetter }}</span>
  </div>
</template>

<script>
export default {
  props: {
    name: {
      type: String,
      required: true,
    },
    height: {
      type: Number,
      required: false,
      default: 18,
    },
  },
  computed: {
    firstLetter() {
      return this.name.charAt(0).toUpperCase();
    },
    boxStyle() {
      return 'rounded-lg bg-blue-500 flex items-center justify-center';
    },
  },
};
</script>


change this so if the height is less than 14 the font is text-2xs

---

## Assistant

To change the font size to "text-2xs" when the height is less than 14, you can modify the template as follows:

```html
<template>
  <div
    class="flex items-center justify-center rounded-md bg-indigo-300 p-1 dark:bg-jovieDark-400"
    :style="{ height: `${height}px`, width: `${height}px` }"
  >
    <span :class="['items-center', height < 14 ? 'text-2xs' : 'text-xs', 'text-white']">{{ firstLetter }}</span>
  </div>
</template>
```

In this updated template, we added a dynamic class binding for the `<span>` element using `:class`. The `['items-center', height < 14 ? 'text-2xs' : 'text-xs', 'text-white']` array syntax allows us to conditionally apply the `text-2xs` class when the `height` prop is less than 14. Otherwise, it applies the `text-xs` class. The `text-white` class is applied in both cases.

By making this change, the font size will be "text-2xs" when the `height` prop is less than 14, and "text-xs" when it is 14 or greater.
