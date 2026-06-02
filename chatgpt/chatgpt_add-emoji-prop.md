---
title: "Add Emoji Prop"
type: note
created: 2023-06-01
updated: 2023-06-01
source: chatgpt-export
conversation_id: 888f176d-a819-4d84-8072-260d48c00e3c
message_count: 2
tags: [chatgpt, import, code]
---
# Add Emoji Prop

> Conversation ID: 888f176d-a819-4d84-8072-260d48c00e3c
> Created: 2023-06-01T23:06:16Z
> Updated: 2023-06-01T23:06:31Z
> Messages: 2

---

## User

<template>
  <div
    class="flex items-center justify-center rounded bg-indigo-300 p-1 dark:bg-jovieDark-400"
    :style="{ height: `${height}px`, width: `${height}px` }">
    <span
      :class="[
        'items-center',
        height < 14 ? 'text-[8px]' : 'text-xs',
        'text-white',
      ]"
      >{{ firstLetter }}</span
    >
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
  },
};
</script>


modify this component to also accept an emoji

---

## Assistant

To modify the component to accept an emoji as a prop, you can follow these steps:

1. Add a new prop called `emoji` to the component:
```javascript
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
  emoji: {
    type: String,
    required: false,
    default: '',
  },
},
```

2. Update the template to display the emoji:
```html
<template>
  <div
    class="flex items-center justify-center rounded bg-indigo-300 p-1 dark:bg-jovieDark-400"
    :style="{ height: `${height}px`, width: `${height}px` }">
    <span
      :class="[
        'items-center',
        height < 14 ? 'text-[8px]' : 'text-xs',
        'text-white',
      ]"
    >
      {{ emoji }} {{ firstLetter }}
    </span>
  </div>
</template>
```
Here, `{{ emoji }}` is added before `{{ firstLetter }}` to display the emoji.

3. Now you can use the modified component and pass the `emoji` prop when using it:
```html
<template>
  <div>
    <EmojiComponent name="OpenAI" height="24" emoji="🚀" />
    <EmojiComponent name="ChatGPT" height="24" emoji="💬" />
  </div>
</template>

<script>
import EmojiComponent from './EmojiComponent.vue';

export default {
  components: {
    EmojiComponent,
  },
};
</script>
```

In the example above, we are using the modified component `EmojiComponent` and passing the `emoji` prop with the desired emoji value.


## See Also
- [[chatgpt/chatgpt_add-path-prop]]
- [[chatgpt/chatgpt_add-prop-to-vue-component]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_emoji-friendly-changelog-conversion]]
- [[chatgpt/chatgpt_movie-prop-pay-stubs]]
