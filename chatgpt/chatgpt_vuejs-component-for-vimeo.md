---
title: "Vue.js component for Vimeo"
type: note
created: 2023-03-01
updated: 2023-03-01
source: chatgpt-export
conversation_id: 1c531311-00fa-4084-a6a2-57feb19339ff
message_count: 4
tags: [chatgpt, import, code]
---
# Vue.js component for Vimeo

> Conversation ID: 1c531311-00fa-4084-a6a2-57feb19339ff
> Created: 2023-03-01T03:23:52Z
> Updated: 2023-03-01T03:23:52Z
> Messages: 4

---

## User

<template>
  <div class="">
    <iframe 
      title="Videos"
      :src="getVideoSrc(videoId)"
      webkitallowfullscreen
      class="h-96 w-full justify-end"
      mozallowfullscreen
      allowfullscreen
    >
    </iframe>
  </div>
</template>
<script>
export default {
  methods: {
    getVideoSrc(videoId) {
      return (
        "https://player.vimeo.com/video/" +
        videoId +
        "?background=1&autoplay=1&loop=1&byline=0&title=0"
      );
    },
  },
  props: {
    videoId: {
      type: String,
      required: true,
    },
  },
};
</script>


---

## Assistant

This is a Vue.js component that displays a Vimeo video player. 

The component template defines a `div` container with an `iframe` element inside it. The `iframe` is used to embed the Vimeo player and has the `src` attribute set to the result of the `getVideoSrc` method, which takes a `videoId` prop as its argument.

The `getVideoSrc` method returns a URL string that points to the Vimeo video with the specified `videoId`. It sets several options for the video player, such as autoplay, loop, and hiding the video's title and byline.

The component defines a `props` object that specifies the `videoId` prop, which is required and must be a string. 

Overall, this component can be used to easily embed and customize Vimeo videos in a Vue.js application.

---

## User

while the vimeo video is loading i need to show a loader

---

## Assistant

To show a loader while the Vimeo video is loading, you can modify the Vue.js component as follows:

```
<template>
  <div class="">
    <div v-if="isLoading" class="loader">Loading...</div>
    <iframe 
      v-else
      title="Videos"
      :src="getVideoSrc(videoId)"
      webkitallowfullscreen
      class="h-96 w-full justify-end"
      mozallowfullscreen
      allowfullscreen
    >
    </iframe>
  </div>
</template>
<script>
export default {
  data() {
    return {
      isLoading: true
    }
  },
  mounted() {
    this.$nextTick(() => {
      this.$refs.video.addEventListener('load', () => {
        this.isLoading = false;
      });
    });
  },
  methods: {
    getVideoSrc(videoId) {
      return (
        "https://player.vimeo.com/video/" +
        videoId +
        "?background=1&autoplay=1&loop=1&byline=0&title=0"
      );
    },
  },
  props: {
    videoId: {
      type: String,
      required: true,
    },
  },
};
</script>
```

In this modified component, a `div` with a `loader` class is added that displays the text "Loading..." when the `isLoading` variable is true. When the `isLoading` variable is false, the Vimeo player is displayed instead.

The `isLoading` variable is initialized to `true` in the component's `data` function. 

In the `mounted` lifecycle hook, an event listener is added to the `iframe` element using the `$refs` property to wait for the video to finish loading. When the video's `load` event is fired, the `isLoading` variable is set to `false`.

This modification allows you to display a loader until the video is fully loaded and ready to play.
