---
title: "Vue JS Emoji Picker Modal"
type: guide
created: 2022-12-29
updated: 2022-12-29
source: chatgpt-export
topic: coding-web
message_count: 10
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Vue JS Emoji Picker Modal

> **Source:** ChatGPT conversation
> **Date:** 2022-12-29T04:20:45Z
> **Messages:** 10
> **Topic:** coding-web

## Question

  <EmojiPickerModal
                    class="mr-1"
                    @emojiSelected="emojiSelected($event, element)"
                    :currentEmoji="element.emoji">
                  </EmojiPickerModal>

## Answer

This code snippet appears to be using the `EmojiPickerModal` component, which has a custom event called `emojiSelected` and a prop called `currentEmoji`. The `emojiSelected` event is triggered when the user selects an emoji from the modal, and the `currentEmoji` prop is used to pass in the current emoji that is displayed in the modal.

The `emojiSelected` event handler function is passed two arguments: `$event` and `element`. The `$event` argument is the event object that is emitted by the `emojiSelected` event, and the `element` argument is likely a reference to an element in the component's data model.

It looks like this component is used to allow the user to select an emoji and then store it in the `element.emoji` property. When the user selects a new emoji, the `emojiSelected` event is triggered and the `emojiSelected` event handler function is called with the new emoji. The `element.emoji` property is then updated with the new value.

## Question

this is the component
<template>
  <div class="">
    <Popover as="div" class="relative">
      <Float portal shift placement="right-start">
        <PopoverButton>
          <span
            :class="
              xl
                ? 'rounded-md px-4 py-4 text-4xl hover:bg-slate-100 dark:hover:bg-jovieDark-700'
                : 'text-sm'
            ">
            {{ currentEmoji || '📄' }}
          </span>
        </PopoverButton>
        <PopoverPanel
          v-slot="{ close }"
          class="z-40 mt-3 w-screen rounded-lg border border-slate-300 bg-white/60 px-4 shadow-lg backdrop-blur-2xl backdrop-saturate-150 dark:border-jovieDark-border sm:px-0 lg:w-60">
          <EmojiPicker
            disable-skin-tones
            native
            :theme="theme"
            @select="handleEmojiSelection" />
        </PopoverPanel>
      </Float>
    </Popover>
  </div>
</template>

<script>
import { ChevronDownIcon } from '@heroicons/vue/20/solid';
import { Float } from '@headlessui

## Answer

This is the code for a Vue.js component called `EmojiPickerModal`. The component displays an emoji picker in a popover and allows the user to select an emoji. When the user selects an emoji, the component emits an `emojiSelected` event with the selected emoji as the argument. The parent component can then listen for this event and use the selected emoji as needed.

The component has several props, including `xl` and `currentEmoji`. The `xl` prop is a boolean that determines whether the emoji picker button should be displayed as a large button (if `true`) or a small button (if `false`). The `currentEmoji` prop is a string that specifies the current emoji displayed in the button.

The component also has several computed properties and methods, including `theme`, `handleEmojiSelection`, and `emojiSelected`. The `theme` computed property retrieves the theme from the Vuex store and returns it. The `handleEmojiSelection` method is called when the user selects an emoji from the picker and closes the popover. The `emojiSelected` method is called when the user selects an emoji and emits the `emojiSelected` event with the selected emoji.

It looks like this component uses the `vue3-emoji-picker` library to display the emoji picker, and the `headlessui` library for the popover and float components. It also uses the `@heroicons/vue` library for some of the icons.

## Question

how can i make the component support v-model instead of binding the currentEmoji and use the emit

## Answer

To make the `EmojiPickerModal` component support `v-model`, you can do the following:

1. Add a `value` prop to the component's prop list. This prop will hold the value of the `v-model` directive:

```
props: {
  xl: {
    type: Boolean,
    default: false,
  },
  value: {
    type: String,
    required: true,
  },
},
```

2. Replace all references to the `currentEmoji` prop with the `value` prop. For example, in the `PopoverButton` component, you would replace `{{ currentEmoji || '📄' }}` with `{{ value || '📄' }}`.

3. Bind the `value` prop to the `v-model` directive using the `v-bind` directive. For example:

```
<EmojiPickerModal v-bind="value" v-model="emoji"></EmojiPickerModal>
```

4. Remove the `currentEmoji` prop from the component's prop list.

5. In the `emojiSelected` method, update the `value` prop with the selected emoji instead of emitting the `emojiSelected` event. For example:

```
emojiSelected(emoji) {
  this.value = emoji;
},
```

With these changes, the `EmojiPickerModal` component will support `v-model` and will automatically update the `emoji` variable in the parent component whenever the user selects a new emoji. 

## Question

so i  want to v-model this to currentEmojiOne how would i do that

## Answer

To use the `EmojiPickerModal` component with a `v-model` directive that targets the `currentEmojiOne` variable, you can do the following:

1. In the parent component's template, bind the `v-model` directive to the `currentEmojiOne` variable:

```
<EmojiPickerModal v-bind="currentEmojiOne" v-model="currentEmojiOne"></EmojiPickerModal>
```

2. In the `EmojiPickerModal` component, add a `value` prop to the component's prop list and bind it to the `v-model` directive using the `v-bind` directive:

```
props: {
  xl: {
    type: Boolean,
    default: false,
  },
  value: {
    type: String,
    required: true,
  },
},
```

```
<template>
  <div class="">
    <!-- other code here -->
  </div>
</template>

<script>
export default {
  // other code here
  props: {
    xl: {
      type: Boolean,
      default: false,
    },
    value: {
      type: String,
      required: true,
    },
  },
  // other code here
};
</script>
```

3. Replace all references to the `currentEmoji` prop with the `value` prop:

```
<template>
  <div class="">
    <Popover as="div" class="relative">
      <Float portal shift placement="right-start">
        <PopoverButton>
          <span
            :class="
              xl
                ? 'rounded-md px-4 py-4 text-4xl hover:bg-slate-100 dark:hover:bg-jovieDark-700'
                : 'text-sm'
            ">
            {{ value || '📄' }}
          </span>
        </PopoverButton>
        <PopoverPanel
          v-slot="{ close }"
          class="z-40 mt-3 w-screen rounded-lg border border-slate-300 bg-white/60 px-4 shadow-lg backdrop-blur-2xl backdrop-saturate-150 dark:border-jovieDark-border sm:px-0 lg:w-60">
          <EmojiPicker
            disable-skin-tones
            native
            :theme="theme"
            @select="handleEmojiSelection" />
        </PopoverPanel>
      </Float>
    </Popover>
  </div>
</template>

<script>
export default {
  // other code here
  methods: {
    handleEmojiSelection(emoji) {
      this.emojiSelected(emoji.i);
      console.log(emoji.i);
      close();
    },

    emojiSelected(emoji) {
      // update the value prop with the selected emoji
      this.value = emoji;
    },
  },
};
</script>
```

With these changes, the `EmojiPickerModal` component will support

## Question

if the store.state.theme is dark change the css to dark theme

## Answer

To change the CSS of the `EmojiPickerModal` component based on the value of the `store.state.theme` variable, you can do the following:

1. In the component's template, bind a class to the element using the `v-bind:class` directive, and use a computed property to determine the value of the class based on the `store.state.theme` variable:

```
<template>
  <div class="relative" v-bind:class="{ 'dark-theme': theme === 'dark' }">
    <!-- other code here -->
  </div>
</template>
```

2. In the component's script, define the `theme` computed property to return the value of the `store.state.theme` variable:

```
<script>
export default {
  // other code here
  computed: {
    theme() {
      return this.$store.state.theme;
    },
  },
  // other code here
};
</script>
```

3. In the component's CSS, define styles for the `dark-theme` class that will be applied when the `store.state.theme` variable is set to `'dark'`:

```
<style>
/* other styles here */

.dark-theme .v3-emoji-picker {
  /* dark theme styles here */
}
</style>
```

With these changes, the `EmojiPickerModal` component will have a dark theme when the `store.state.theme` variable is set to `'dark'`, and a light theme when the `store.state.theme` variable is set to any other value.
