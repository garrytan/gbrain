---
title: "Tailwind CSS Transition Horizontal Line"
type: guide
created: 2022-12-23
updated: 2022-12-23
source: chatgpt-export
conversation_id: 78796ac3-6c57-40ef-af8c-1b804d493fed
message_count: 6
tags: [chatgpt, import, code]
---
# Tailwind CSS Transition Horizontal Line

> Conversation ID: 78796ac3-6c57-40ef-af8c-1b804d493fed
> Created: 2022-12-23T02:53:26Z
> Updated: 2022-12-23T02:53:26Z
> Messages: 6

---

## User

using tailwind css make a white horizantal line that transitions from filling 25% of the width to 100%. it should be slow.

---

## Assistant

To create a white horizontal line that transitions from filling 25% of the width to 100% using Tailwind CSS, you can use the `bg-white` and `w-full` utility classes along with the `transition` utility to specify the transition duration and easing. Here's an example of how you can do this:

```
<div class="bg-white w-25 transition-all duration-300 ease-in-out">
</div>
```

This will create a white horizontal line that is initially 25% of the width and transitions to 100% width over a duration of 300ms (0.3 seconds) with an easing of "in-out".

You can adjust the transition duration and easing to your liking by modifying the `duration` and `ease` values. For example, to make the transition slower, you can increase the `duration` value. To make the transition more gradual, you can use a different easing function such as `ease-in` or `ease-out`.

Here's an example of how you can use the `w-full` utility class to transition the line to 100% width:

```
<div class="bg-white w-25 transition-all duration-300 ease-in-out hover:w-full">
</div>
```

This will create a white horizontal line that transitions to 100% width when hovered over, using the same transition duration and easing as before.


---

## User

can you delay this by 300ms

---

## Assistant

Yes, you can use the `transition-delay` utility to add a delay to the transition. For example, to add a delay of 300ms (0.3 seconds) to the transition, you can update the line like this:

```
<div class="bg-white w-25 transition-all duration-300 ease-in-out transition-delay-300 hover:w-full">
</div>
```

This will add a delay of 300ms before the transition starts, causing the transition to start 300ms after the element is hovered over.

You can adjust the delay by modifying the value of the `transition-delay` utility. For example, to increase the delay to 500ms (0.5 seconds), you can use `transition-delay-500`.

Keep in mind that the `transition-delay` utility should be used in conjunction with the `transition` utility, which specifies the transition duration and easing. If you don't specify a `transition` utility, the `transition-delay` utility will have no effect.


---

## User

emits: ['update:modelValue'],

add an emit for blur

---

## Assistant

To add an emit for the `blur` event in your Vue.js component, you can add a new item to the `emits` array like this:

```
emits: ['update:modelValue', 'blur'],
```

This will allow your component to emit a `blur` event when the element loses focus. You can then listen for this event in the parent component using the `@blur` event listener syntax.

Here's an example of how you can use the `blur` event in your component:

```
<template>
  <div>
    <input type="text" v-model="modelValue" @blur="onBlur" />
  </div>
</template>

<script>
export default {
  props: ['modelValue'],
  emits: ['update:modelValue', 'blur'],
  methods: {
    onBlur() {
      this.$emit('blur');
    }
  }
};
</script>
```

In this example, the `input` element is bound to the `modelValue` prop using the `v-model` directive. When the element loses focus (i.e. when the `blur` event is triggered), the `onBlur` method is called, which emits the `blur` event.

You can then listen for the `blur` event in the parent component like this:

```
<template>
  <my-component @blur="onBlur" />
</template>

<script>
export default {
  methods: {
    onBlur() {
      // do something when the blur event is emitted
    }
  }
};
</script>
```

This will call the `onBlur` method in the parent component whenever the `blur` event is emitted by the `my-component` component.

