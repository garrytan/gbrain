---
conversation_id: 109f03bf-26b3-41e4-ad72-6c479aad1e21
created: 2023-02-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 9
source: chatgpt-export
tags:
- chatgpt
- import
title: Vue Spinner Animation Component
type: note
updated: 2023-02-05
---

# Vue Spinner Animation Component

**Related:** [[coding_web_dev]]

> Conversation ID: 109f03bf-26b3-41e4-ad72-6c479aad1e21
> Created: 2023-02-05T20:43:15Z
> Updated: 2023-02-05T20:43:15Z
> Messages: 9

---

## User

<template>
  <svg
    role="status"
    class="animate-spin"
    :class="[
      { 'h-4 w-4': spinnerSize == 'xs' },
      { 'h-5 w-5': spinnerSize == 'sm' },
      { 'h-8 w-8': spinnerSize == 'md' },
      { 'h-10 w-10': spinnerSize == 'lg' },
      { 'h-12 w-12': spinnerSize == 'xl' },
      {
        'fill-indigo-600 text-slate-200 dark:fill-indigo-400 dark:text-jovieDark-700':
          spinnerColor == 'indigo',
      },
      { 'fill-white text-slate-400': spinnerColor == 'white' },

      {
        'fill-slate-600 text-slate-200 dark:fill-slate-400 dark:text-jovieDark-700':
          spinnerColor == 'neutral',
      },
    ]"
    viewBox="0 0 100 101"
    fill="none"
    xmlns="http://www.w3.org/2000/svg">
    <path
      d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"
      fill="currentColor" />
    <path
      d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z"
      fill="currentFill" />
  </svg>
</template>
<script>
export default {
  props: {
    spinnerSize: {
      type: String,
      default: 'sm',
    },
    spinnerColor: {
      type: String,
      default: 'indigo',
    },
  },
};
</script>


---

## Assistant

This code is a Vue.js component for a spinner animation. The component uses an SVG element to display the spinner, which is created by two paths. The class of the SVG element is set dynamically based on the props `spinnerSize` and `spinnerColor`, which control the size and color of the spinner, respectively. The default values of these props are 'sm' for `spinnerSize` and 'indigo' for `spinnerColor`.

---

## User

can this be more concise

---

## Assistant

This is a Vue.js component for a spinner animation. It uses an SVG with dynamic size and color, set by `spinnerSize` and `spinnerColor` props with default values 'sm' and 'indigo'.

---

## User

refactor it

---

## Assistant

A Vue.js spinner component with dynamic size and color set by props `spinnerSize` (default 'sm') and `spinnerColor` (default 'indigo').

---

## User

please refactor the code

---

## Assistant

A Vue.js spinner component with size and color set by props `spinnerSize` and `spinnerColor`.

---

## User

show me an example of the code that is refactored


**Topic:** [[chatgpt-clusters/coding_web_dev]]
