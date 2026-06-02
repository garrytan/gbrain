---
conversation_id: 1c48097a-2f3c-404a-96d7-04980767bdb5
created: 2023-02-26
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Vue.js WorkSection Component
type: note
updated: 2023-02-26
---

# Vue.js WorkSection Component

**Related:** [[coding_web_dev]]

> Conversation ID: 1c48097a-2f3c-404a-96d7-04980767bdb5
> Created: 2023-02-26T00:16:24Z
> Updated: 2023-02-26T00:16:24Z
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
    imageSrc: 'src\assets\images\tahiti.jpg',
    title: 'Travel',
    videoId: '802302516',
    subtitle: 'Tahiti',
    buttonLink: '#'
  }
];
</script>

---

## Assistant

This is a Vue.js component template with a script section that imports the `WorkSection` component and defines an array of `items` which contains two objects with properties such as `imageSrc`, `videoId`, `title`, `subtitle`, and `buttonLink`. 

In the template section, the `WorkSection` component is used with a `:items` prop that is bound to the `items` array defined in the script section. The `WorkSection` component will receive the `items` array as a prop and render the contents of each object in the array as a separate section.

The first object in the `items` array has an image of a Lamborghini and the second object has an image of Tahiti, along with other details such as a title, subtitle, and button link.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-worksection-component-2]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_modify-vuejs-component-for-arrow-key-navigation]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part1]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part2]]
