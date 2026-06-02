---
title: "Vue JS Emoji Picker Modal"
type: guide
created: 2022-12-29
updated: 2022-12-29
source: chatgpt-export
conversation_id: ee8911a3-b63b-4bf0-ae2d-025d2366e2cf
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Vue JS Emoji Picker Modal

> Conversation ID: ee8911a3-b63b-4bf0-ae2d-025d2366e2cf
> Created: 2022-12-29T04:20:45Z
> Updated: 2022-12-29T04:20:45Z
> Messages: 10

---

## User

  <EmojiPickerModal
                    class="mr-1"
                    @emojiSelected="emojiSelected($event, element)"
                    :currentEmoji="element.emoji">
                  </EmojiPickerModal>

---

## Assistant

This code snippet appears to be using the `EmojiPickerModal` component, which has a custom event called `emojiSelected` and a prop called `currentEmoji`. The `emojiSelected` event is triggered when the user selects an emoji from the modal, and the `currentEmoji` prop is used to pass in the current emoji that is displayed in the modal.

The `emojiSelected` event handler function is passed two arguments: `$event` and `element`. The `$event` argument is the event object that is emitted by the `emojiSelected` event, and the `element` argument is likely a reference to an element in the component's data model.

It looks like this component is used to allow the user to select an emoji and then store it in the `element.emoji` property. When the user selects a new emoji, the `emojiSelected` event is triggered and the `emojiSelected` event handler function is called with the new emoji. The `element.emoji` property is then updated with the new value.

---

## User

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
import { Float } from '@headlessui-float/vue';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import { EllipsisVerticalIcon } from '@heroicons/vue/24/solid';
// import picker compopnent
import EmojiPicker from 'vue3-emoji-picker';
import { ref } from 'vue';

export default {
  components: {
    EmojiPicker,
    Popover,
    Float,
    PopoverButton,
    PopoverPanel,
    EllipsisVerticalIcon,
    ChevronDownIcon,
  },
  data() {
    return {
      close: false,
    };
  },
  props: {
    xl: {
      type: Boolean,
      default: false,
    },
    currentEmoji: {
      type: String,
      required: true,
    },
  },
  computed:
    //get the theme from store if its dark return dark if its light return light if its empty return auto
    {
      theme() {
        return this.$store.state.theme;
      },
    },
  methods: {
    handleEmojiSelection(emoji) {
      this.emojiSelected(emoji.i);
      console.log(emoji.i);
      close();
    },

    emojiSelected(emoji) {
      //emit the emoji to the parent component
      this.$emit('emojiSelected', emoji);
    },
  },
};
</script>
<style>
.v3-body-inner {
  scrollbar-color: #393d3f rgba(0, 0, 0, 0.1);
  scrollbar-width: thin;
}
.v3-body-inner::-webkit-scrollbar {
  width: 8px;
}
.v3-body-inner::-webkit-scrollbar-track {
  background-color: transparent;
}
.v3-body-inner::-webkit-scrollbar-thumb {
  display: none;
  background: rgba(0, 0, 0, 0);
  border-radius: 5px;
}
.v3-body-inner:hover::-webkit-scrollbar-thumb {
  display: block;
}
.v3-emoji-picker {
  height: 320px;
  width: 100%;
  color: #000;
  margin: 0 auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  text-align: left;
}
.v3-emoji-picker * {
  box-sizing: border-box;
}
.v3-emoji-picker .v3-header {
  padding: 15px 15px 13px;
  border-bottom: 1px solid #ddd;
}
.v3-emoji-picker .v3-header .v3-groups {
  display: flex;
}
.v3-emoji-picker .v3-header .v3-groups .v3-group {
  flex-grow: 1;
  padding: 0;
  margin: 0;
  border: none;
  background: none;
  font-size: 20px;
  cursor: pointer;
  position: relative;
  display: block;
  opacity: 0.7;
  transition: 0.2s;
}
.v3-emoji-picker .v3-header .v3-groups .v3-group:first-child,
.v3-emoji-picker .v3-header .v3-groups .v3-group:last-child {
  flex-grow: 0;
}
.v3-emoji-picker .v3-header .v3-groups .v3-group:hover {
  opacity: 1;
}
.v3-emoji-picker .v3-header .v3-groups .v3-group span {
  display: flex;
  align-items: center;
  justify-content: center;
}
.v3-emoji-picker .v3-header .v3-groups .v3-group span img {
  display: block;
  width: 1em;
  height: auto;
}
.v3-emoji-picker .v3-spacing {
  height: 11px;
}
.v3-emoji-picker .v3-search input {
  width: 100%;
  display: block;
  height: 26px;
  padding: 0 10px;
  border: 1px solid #e2e8f0;
  border-radius: 0.375rem;
  font-size: 12px;
  transition: 0.2s;
}
.v3-emoji-picker .v3-search input:focus {
  outline: none;
  border-color: #000;
}
.v3-emoji-picker .v3-body {
  padding: 0 0 15px 11px;
  min-height: 0;
  flex-grow: 1;
}
.v3-emoji-picker .v3-body .v3-body-inner {
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  height: 100%;
  padding-right: 11px;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group h5 {
  margin: 0;
  top: 0;
  font-weight: 600;
  color: #334155;
  background: transparent;
  padding: 7px 0 3px 4px;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group h5.v3-sticky {
  position: sticky;
  border-bottom: 1px solid #e2e8f0;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(40px);
  filter: saturate(1.5);
  z-index: 1;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group .v3-emojis {
  display: flex;
  font-size: 14px;
  flex-wrap: wrap;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group .v3-emojis button {
  cursor: pointer;
  border: none;
  background: none;
  margin: 0;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-basis: 12.5%;
  max-width: 12.5%;
  flex-grow: 1;
  padding: 0;
  font-size: 22px;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group .v3-emojis button span {
  display: inline-block;
  padding-left: 1px;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group .v3-emojis button:hover {
  background: #f7f7f7;
}
.v3-emoji-picker .v3-body .v3-body-inner .v3-group .v3-emojis button img {
  max-width: 100%;
  padding: 4px;
}
.v3-emoji-picker .v3-body .v3-body-inner.is-mac .v3-emojis button {
  font-family: 'Apple Color Emoji';
}
.v3-emoji-picker .v3-footer {
  font-size: 14px;
  border-top: 1px solid #dddddd;
  padding: 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
}
.v3-emoji-picker .v3-footer .v3-tone,
.v3-emoji-picker .v3-footer .v3-foot-left {
  display: flex;
  align-items: center;
}
.v3-emoji-picker .v3-footer .v3-tone img,
.v3-emoji-picker .v3-footer .v3-foot-left img {
  width: 20px;
  display: block;
}
.v3-emoji-picker .v3-footer .v3-tone > span:first-child,
.v3-emoji-picker .v3-footer .v3-foot-left > span:first-child {
  margin-right: 6px;
}
.v3-emoji-picker .v3-footer .v3-foot-left > span.v3-text {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v3-emoji-picker .v3-footer .v3-tone {
  border: none;
  padding: 0;
  background: none;
  cursor: pointer;
}
.v3-emoji-picker .v3-footer .v3-tone > span {
  display: inline-flex;
  vertical-align: top;
}
.v3-emoji-picker .v3-footer .v3-tone .v3-text {
  font-size: 10px;
}
.v3-emoji-picker .v3-footer .v3-tone .v3-icon {
  padding-bottom: 3px;
}
.v3-emoji-picker .v3-footer .v3-tone .is-mac span {
  font-family: 'Apple Color Emoji';
}
.v3-skin-tones {
  position: absolute;
  background: white;
  height: 100%;
  width: 60%;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 15px;
  opacity: 0;
  visibility: hidden;
  transition: 0.2s;
  border-radius: 0 0 10px 10px;
}
.v3-skin-tones.v3-is-open {
  opacity: 1;
  visibility: visible;
}
.v3-skin-tones .v3-skin-tone {
  display: inline-block;
  height: 15px;
  width: 25px;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: 0ms;
}
.v3-skin-tones .v3-skin-tone:hover {
  transform: scale(1.1);
  transition: 0.2s;
}
.v3-skin-tones .v3-skin-tone-neutral {
  color: #ffd225;
  background-color: #ffd225;
}
.v3-skin-tones .v3-skin-tone-1f3fb {
  color: #ffdfbd;
  background-color: #ffdfbd;
}
.v3-skin-tones .v3-skin-tone-1f3fc {
  color: #e9c197;
  background-color: #e9c197;
}
.v3-skin-tones .v3-skin-tone-1f3fd {
  color: #c88e62;
  background-color: #c88e62;
}
.v3-skin-tones .v3-skin-tone-1f3fe {
  color: #a86637;
  background-color: #a86637;
}
.v3-skin-tones .v3-skin-tone-1f3ff {
  color: #60463a;
  background-color: #60463a;
}
.v3-input-emoji-picker * {
  box-sizing: border-box;
}
.v3-input-emoji-picker .v3-input-picker-root {
  position: relative;
}
.v3-input-emoji-picker .v3-input-picker-root .v3-emoji-picker-input,
.v3-input-emoji-picker .v3-input-picker-root .v3-emoji-picker-textarea {
  width: 100%;
  height: 40px;
  border: 1px solid #999;
  padding-left: 15px;
}
.v3-input-emoji-picker .v3-input-picker-root .v3-emoji-picker-textarea {
  min-height: 80px;
  resize: vertical;
}
.v3-input-emoji-picker
  .v3-input-picker-root
  .v3-emoji-picker-textarea
  + .v3-input-picker-wrap
  .v3-input-picker-icon {
  top: auto;
  bottom: 5px;
}
.v3-input-emoji-picker
  .v3-input-picker-root
  .v3-input-picker-wrap
  .v3-input-picker-icon {
  display: inline-flex;
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 20px;
  border: none;
  background: none;
  padding: 0 5px;
  cursor: pointer;
}
.v3-input-emoji-picker
  .v3-input-picker-root
  .v3-input-picker-wrap
  .v3-input-picker-icon
  img {
  display: block;
  width: 1em;
  height: 1em;
}
.v3-input-emoji-picker
  .v3-input-picker-root
  .v3-input-picker-wrap
  .v3-emoji-picker {
  opacity: 0;
  visibility: hidden;
  transition: 0.2s;
}
.v3-input-emoji-picker
  .v3-input-picker-root
  .v3-input-picker-wrap.v3-picker-is-open
  .v3-emoji-picker {
  opacity: 1;
  visibility: visible;
  z-index: 999;
}
.v3-emoji-picker.v3-color-theme-auto {
  @media (prefers-color-scheme: dark) {
    --v3-picker-fg: #ffffff;

    --v3-picker-input-bg: #222222;
    --v3-picker-input-border: #444444;
    --v3-picker-input-focus-border: #555555;
    --v3-group-image-filter: invert(1);
    --v3-picker-emoji-hover: #222222;
  }
}
.v3-emoji-picker.v3-color-theme-dark {
  --v3-picker-fg: #ffffff;

  --v3-picker-input-bg: #222222;
  --v3-picker-input-border: #444444;
  --v3-picker-input-focus-border: #555555;
  --v3-group-image-filter: invert(1);
  --v3-picker-emoji-hover: #222222;
}
</style>


---

## Assistant

This is the code for a Vue.js component called `EmojiPickerModal`. The component displays an emoji picker in a popover and allows the user to select an emoji. When the user selects an emoji, the component emits an `emojiSelected` event with the selected emoji as the argument. The parent component can then listen for this event and use the selected emoji as needed.

The component has several props, including `xl` and `currentEmoji`. The `xl` prop is a boolean that determines whether the emoji picker button should be displayed as a large button (if `true`) or a small button (if `false`). The `currentEmoji` prop is a string that specifies the current emoji displayed in the button.

The component also has several computed properties and methods, including `theme`, `handleEmojiSelection`, and `emojiSelected`. The `theme` computed property retrieves the theme from the Vuex store and returns it. The `handleEmojiSelection` method is called when the user selects an emoji from the picker and closes the popover. The `emojiSelected` method is called when the user selects an emoji and emits the `emojiSelected` event with the selected emoji.

It looks like this component uses the `vue3-emoji-picker` library to display the emoji picker, and the `headlessui` library for the popover and float components. It also uses the `@heroicons/vue` library for some of the icons.

---

## User

how can i make the component support v-model instead of binding the currentEmoji and use the emit

---

## Assistant

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

---

## User

so i  want to v-model this to currentEmojiOne how would i do that

---

## Assistant

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

---

## User

if the store.state.theme is dark change the css to dark theme

---

## Assistant

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


**Topic:** [[chatgpt-clusters/coding_web_dev]]
