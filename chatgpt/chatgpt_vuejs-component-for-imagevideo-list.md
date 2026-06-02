---
title: "Vue.js component for image/video list"
type: note
created: 2023-02-26
updated: 2023-02-26
source: chatgpt-export
conversation_id: 33d7621b-4082-4808-97ba-bb2d498085b0
message_count: 2
tags: [chatgpt, import]
---
# Vue.js component for image/video list

> Conversation ID: 33d7621b-4082-4808-97ba-bb2d498085b0
> Created: 2023-02-26T00:11:06Z
> Updated: 2023-02-26T00:11:06Z
> Messages: 2

---

## User

<template>
  <div 
    v-for="(item, index) in items"
    :key="index"
    class="grid min-h-full"
  >
    <div class="relative flex h-[600px]">
      <div v-if="!supportsVideo() || (activeVideo.index == item.index)" class="absolute inset-0 h-full w-full object-cover object-center" 
      :style="{ backgroundImage: 'url(' + item.imageSrc + ')' }"></div>
      
      <div @mouseover="activeVideo = item.index" class="absolute h-full w-full" v-else>
        <iframe
          :src="getVideoSrc(item.videoId)"
          
          webkitallowfullscreen
          mozallowfullscreen
          allowfullscreen
          class="absolute inset-0 h-full w-full"
        ></iframe>
      </div>
      <div class="relative flex w-full flex-col items-start justify-end bg-black bg-opacity-40 p-8 sm:p-12">
        <h2 class="text-lg font-medium text-white text-opacity-75">{{ item.title }}</h2>
        <p class="mt-1 text-2xl font-medium text-white">{{ item.subtitle }}</p>
        <a :href="item.buttonLink" class="mt-4 rounded-md bg-white py-2.5 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50">{{ item.buttonText || 'Watch' }}</a>
      </div>
    </div>
  </div>
</template>

<script >
export default {
  props: {
    items: {
      type: Array,
      required: true,
      default: () => []
    }
  },
  data() {
    return {
      activeVideo: null
    };
  },
  methods: {
    supportsVideo() {
      return !!document.createElement('video').canPlayType;
    },
    getVideoSrc(videoId) {
      return 'https://player.vimeo.com/video/' + videoId + '?background=1&autoplay=1&loop=1&byline=0&title=0';
    }
  }
}
</script>

---

## Assistant

This code defines a Vue.js component that displays a list of items, each with an image or a video, a title, a subtitle, and a button. 

The component loops through the `items` prop array and renders each item inside a `div` element. The `key` attribute is set to the `index` to help Vue.js track the items.

The item's image or video is rendered inside an absolute positioned `div` element with a `relative` parent. If the browser doesn't support video or the video is currently active, the item's image is displayed as a background image. Otherwise, an `iframe` element is used to play the video.

The `activeVideo` data property is used to keep track of the active video, which is the one that's currently being played.

The `supportsVideo` method checks if the browser supports video by creating a new `video` element and checking if it can play any type of video.

The `getVideoSrc` method generates the URL for the Vimeo video player with the given `videoId` and some parameters to make the video loop, autoplay, and hide the byline and title. 

The component exports an object with the component definition, which includes the `props`, `data`, and `methods` objects. The `props` object defines the `items` prop, which is an array of objects with the data for each item. The `data` object defines the `activeVideo` data property, which is initially set to `null`. The `methods` object defines the `supportsVideo` and `getVideoSrc` methods, which are used to check if the browser supports video and generate the video URL, respectively.
