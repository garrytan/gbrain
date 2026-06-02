---
conversation_id: 12dcefb2-e159-4cd7-a476-e0ecaf1cd55e
created: 2023-05-06
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: 'Vue Component: Colored Initials'
type: note
updated: 2023-05-06
---

# Vue Component: Colored Initials

**Related:** [[coding_web_dev]]

> Conversation ID: 12dcefb2-e159-4cd7-a476-e0ecaf1cd55e
> Created: 2023-05-06T22:57:02Z
> Updated: 2023-05-06T22:57:19Z
> Messages: 2

---

## User

make a vue.js componet that has a prop for name. it should take the first letter of the name (which is a string) and then display it in a colored box with rounded corners. The size of the box should be set with a height prop and the width should match the height. use the options api and tailwind css.

---

## Assistant

Sure! Here's an example of a Vue.js component that meets your requirements using the Options API and Tailwind CSS:

```vue
<template>
  <div :class="boxStyle" :style="{ height: `${height}px`, width: `${height}px` }">
    <span class="text-white text-lg">{{ firstLetter }}</span>
  </div>
</template>

<script>
export default {
  props: {
    name: {
      type: String,
      required: true
    },
    height: {
      type: Number,
      required: true
    }
  },
  computed: {
    firstLetter() {
      return this.name.charAt(0).toUpperCase();
    },
    boxStyle() {
      return 'rounded-lg bg-blue-500 flex items-center justify-center';
    }
  }
};
</script>

<style scoped>
  .box-style {
    /* You can customize the box style here */
  }
</style>
```

In this component, we define two props: `name` and `height`. The `name` prop is used to get the first letter of the name and display it in the colored box. The `height` prop is used to set the height and width of the box.

The template contains a `div` element that uses dynamic class binding to apply the box styles. We set the height and width of the box using the `height` prop. Inside the box, we display the first letter of the name in a `span` element.

In the script section, we define a computed property `firstLetter` that extracts the first letter of the `name` prop and converts it to uppercase. We also define a computed property `boxStyle` that returns the Tailwind CSS classes for the colored box.

You can further customize the box style by modifying the `.box-style` class in the scoped `<style>` section.

Remember to include Vue.js and Tailwind CSS in your project for this component to work properly.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
