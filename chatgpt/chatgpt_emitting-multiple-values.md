---
title: "Emitting Multiple Values"
type: note
created: 2023-05-24
updated: 2023-05-24
source: chatgpt-export
conversation_id: d245652a-7689-423f-be88-40b04fc7f921
message_count: 2
tags: [chatgpt, import, code]
---
# Emitting Multiple Values

> Conversation ID: d245652a-7689-423f-be88-40b04fc7f921
> Created: 2023-05-24T00:39:24Z
> Updated: 2023-05-24T00:39:31Z
> Messages: 2

---

## User

in vue 3 im trying to emit multiple values to a parent

   this.$emit('subMenuItemClicked', item, id);

its not working

---

## Assistant

In Vue 3, emitting multiple values to a parent component can be achieved by passing an object or an array as the second argument to the `$emit` function. Here's an example of how you can emit multiple values:

```javascript
this.$emit('subMenuItemClicked', { item, id });
```

In the parent component, you can access these values through the event object:

```html
<template>
  <child-component @subMenuItemClicked="handleSubMenuItemClicked"></child-component>
</template>

<script>
export default {
  methods: {
    handleSubMenuItemClicked(event) {
      const { item, id } = event;
      // Use the emitted values
    }
  }
}
</script>
```

Make sure that you're listening to the correct event name (`subMenuItemClicked`) in the parent component and that the event handler method (`handleSubMenuItemClicked`) is correctly defined.


## See Also
- [[chatgpt/chatgpt_vuejs-emitting-events]]
- [[chatgpt/chatgpt_attractive-ffmi-values]]
- [[chatgpt/chatgpt_ci-for-multiple-prs]]
- [[chatgpt/chatgpt_core-values-compilation-part1]]
- [[chatgpt/chatgpt_core-values-compilation-part2]]
