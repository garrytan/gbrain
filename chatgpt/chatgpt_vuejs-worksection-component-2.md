---
title: "Vue.js WorkSection Component"
type: note
created: 2023-02-26
updated: 2023-02-26
source: chatgpt-export
conversation_id: f0cf3100-ae11-4670-87bd-48ab16e17a3e
message_count: 2
tags: [chatgpt, import]
---
# Vue.js WorkSection Component

> Conversation ID: f0cf3100-ae11-4670-87bd-48ab16e17a3e
> Created: 2023-02-26T00:17:03Z
> Updated: 2023-02-26T00:17:03Z
> Messages: 2

---

## User

<template>
  <div>
    <WorkSection :items="items" />
  </div>
</template>

<script setup >
import WorkSection from "../components/WorkSection.vue";



const items = [
  {
    imageSrc: 'https://tailwindui.com/img/ecommerce-images/home-page-02-edition-01.jpg',
    videoId: '413720595',
    title: 'Automotive',
    subtitle: 'Lamborghini',
    buttonLink: '#'
  },
  {
    imageSrc: 'src/assets/images/tahiti.jpg',
    title: 'Travel',
    videoId: '802302516',
    subtitle: 'Tahiti',
    buttonLink: '#'
  }
];
</script>

---

## Assistant

This code is a Vue.js single file component that defines a template and script for rendering a `WorkSection` component with a list of `items`. 

The `template` section contains a single `div` element that wraps the `WorkSection` component with a `:items` prop set to the `items` array defined in the `script` section.

The `script` section defines a `const` variable named `items` that is an array of objects, where each object represents an item in the `WorkSection`. Each item has a `imageSrc`, `videoId`, `title`, `subtitle`, and `buttonLink` property that will be used to display the item.

The `import` statement imports the `WorkSection` component from a file located at `"../components/WorkSection.vue"`. 

Overall, this code sets up a basic Vue.js component with a pre-defined list of items that can be used to display a `WorkSection` component with relevant content.
