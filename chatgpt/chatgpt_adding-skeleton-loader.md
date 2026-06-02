---
title: "Adding Skeleton Loader."
type: note
created: 2023-04-18
updated: 2023-04-18
source: chatgpt-export
conversation_id: 99a8bfdd-0c60-499c-afac-322dc1aa5b69
message_count: 2
tags: [chatgpt, import, code]
---
# Adding Skeleton Loader.

> Conversation ID: 99a8bfdd-0c60-499c-afac-322dc1aa5b69
> Created: 2023-04-18T20:20:13Z
> Updated: 2023-04-18T20:20:39Z
> Messages: 2

---

## User

 <ContactAvatar :contact="contact" class="mr-2" />

add a skeleton loader

---

## Assistant

To add a skeleton loader to the ContactAvatar component, you can use a conditional rendering technique to display the skeleton loader when the component is loading or fetching data. Here's an example implementation:

```
<template>
  <div>
    <div v-if="loading" class="skeleton-loader"></div>
    <img v-else :src="contact.avatarUrl" class="contact-avatar mr-2" />
  </div>
</template>

<script>
export default {
  props: {
    contact: {
      type: Object,
      required: true,
    },
    loading: {
      type: Boolean,
      default: false,
    },
  },
};
</script>

<style>
.skeleton-loader {
  width: 50px;
  height: 50px;
  background-color: #eee;
  border-radius: 50%;
  display: inline-block;
  margin-right: 8px;
  animation: skeleton-pulse 1s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0% {
    opacity: 0.4;
  }
  50% {
    opacity: 0.8;
  }
  100% {
    opacity: 0.4;
  }
}
</style>
```

In this implementation, the `loading` prop is used to control the display of the skeleton loader. When `loading` is true, the skeleton loader is displayed, and when it's false, the contact avatar image is displayed. The skeleton loader is a simple div with a background color, border-radius, and animation to simulate a loading effect. You can adjust the size and animation properties to fit your needs.
