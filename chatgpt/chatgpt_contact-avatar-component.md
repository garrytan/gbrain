---
conversation_id: 7a6b6ee2-c587-417b-be93-4f2c74080b19
created: 2023-05-17
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Contact Avatar Component
type: note
updated: 2023-05-17
---

# Contact Avatar Component

**Related:** [[coding_web_dev]]

> Conversation ID: 7a6b6ee2-c587-417b-be93-4f2c74080b19
> Created: 2023-05-17T00:03:42Z
> Updated: 2023-05-17T00:04:02Z
> Messages: 2

---

## User

<template>
  <div
    class="mx-auto aspect-square flex-shrink-0 justify-center object-cover object-center"
    :class="[
      { 'h-40 w-40': size == 'md' },
      { 'h-24 w-24': size == 'sm' },
      { 'h-12 w-12': size == 'xsm' },
      { 'h-6 w-6': size == 'xxsm' },
    ]">
    <div
      class="rounded-full p-1"
      :class="[
        { 'bg-slate-200': !network },
        {
          'bg-social-youtube/60': network == 'youtube',
        },
        {
          'bg-social-twitter/90': network == 'twitter',
        },
        {
          'bg-gradient-to-tr from-yellow-500/90 via-fuchsia-500/90 to-purple-500/90':
            network == 'instagram',
        },
        {
          'bg-social-snapchat': network == 'snapchat',
        },
        {
          'bg-gradient-to-l from-pink-700 to-sky-700': network == 'tiktok',
        },
      ]">
      <div class="items-center justify-center rounded-full bg-white p-0">
        <img
          @error="switchToDefaultImage"
          class="justify-center rounded-full object-cover object-center"
          :class="[
            { 'h-40 w-40': size == 'md' },
            { 'h-24 w-24': size == 'sm' },
            { 'h-12 w-12': size == 'xsm' },
            { 'h-6 w-6': size == 'xxsm' },
          ]"
          :src="displayImageUrl"
          :alt="name" />
      </div>
    </div>
  </div>
</template>
<script>
export default {
  name: 'ContactAvatar',
  data() {
    return {
      defaultImageUrl: `asset('img/noimage.webp')`,
    };
  },
  computed: {
    displayImageUrl() {
      return this.imageUrl || this.defaultImageUrl;
    },
  },
  props: {
    imageUrl: {
      type: String,
      default: 'image',
    },
    name: {
      type: String,
      default: 'Contact',
    },
    size: {
      type: String,
      default: 'md',
    },
    network: {
      type: String,
      default: null,
    },
    height: {
      type: Number,
      default: 48,
    },
  },
};
</script>


---

## Assistant

This is a Vue component named "ContactAvatar" that represents an avatar for a contact. It is written using the Vue 2 syntax.

The component template defines the structure of the avatar. It consists of a container `<div>` with several nested `<div>` elements. The outermost `<div>` has the classes "mx-auto aspect-square flex-shrink-0 justify-center object-cover object-center". These classes control the positioning and sizing of the avatar.

Inside the outer `<div>`, there is another `<div>` element with the classes "rounded-full p-1". This element represents the background of the avatar and its appearance depends on the value of the `network` prop. The classes are conditionally applied based on the value of `network` using Vue's binding syntax.

Inside the background `<div>`, there is another `<div>` element with the classes "items-center justify-center rounded-full bg-white p-0". This element contains an `<img>` tag representing the actual image of the avatar. The image source is determined by the `imageUrl` prop. If the `imageUrl` is not provided, it falls back to a default image defined by the `defaultImageUrl` property.

The component also defines some computed properties and props. The `displayImageUrl` computed property returns the `imageUrl` prop if it is provided, otherwise it returns the `defaultImageUrl`.

The component accepts several props:
- `imageUrl` (String, default: 'image'): The URL of the image for the avatar.
- `name` (String, default: 'Contact'): The name of the contact.
- `size` (String, default: 'md'): The size of the avatar. It can be 'md', 'sm', 'xsm', or 'xxsm'.
- `network` (String, default: null): The social network associated with the contact. It can be 'youtube', 'twitter', 'instagram', 'snapchat', 'tiktok', or null.
- `height` (Number, default: 48): The height of the avatar in pixels.

The component also has a `data` function that returns an object with a `defaultImageUrl` property, which is set to the string `'asset('img/noimage.webp')'`. This is a placeholder for the default image URL.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
