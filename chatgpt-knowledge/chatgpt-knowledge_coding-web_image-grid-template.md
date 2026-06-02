---
title: "Image grid template."
type: guide
created: 2023-02-25
updated: 2023-02-25
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Image grid template.

> **Source:** ChatGPT conversation
> **Date:** 2023-02-25T04:00:35Z
> **Messages:** 6
> **Topic:** coding-web

## Question

<template>
  <!--
    This example requires updating your template:

    ```
    <html class="h-full bg-gray-50">
    <body class="h-full">
    ```
  -->
  <div 
  v-for="i in 7"
  :key="i"
  class="grid min-h-full ">
    <div class="relative flex h-96">
      <img src="https://tailwindui.com/img/ecommerce-images/home-page-02-edition-01.jpg" alt="" class="absolute inset-0 h-full w-full object-cover object-center" />
      <div class="relative flex w-full flex-col items-start justify-end bg-black bg-opacity-40 p-8 sm:p-12">
        <h2 class="text-lg font-medium text-white text-opacity-75">Self-Improvement</h2>
        <p class="mt-1 text-2xl font-medium text-white">Journals and note-taking</p>
        <a href="#" class="mt-4 rounded-md bg-white py-2.5 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50">Shop now</a>
      </div>
    </div>
    
  </div>
</template>


## Answer

This is a Vue.js template using Tailwind CSS classes to create a responsive grid of images with text overlays. 

The template uses a v-for loop to create 7 instances of a grid container with a minimum height of the full viewport. Inside the grid container, there is a relative div with a height of 96 viewport units (vh), containing an image with a black semi-transparent overlay. The text content is positioned at the bottom of the image overlay and includes a title, subtitle, and a call-to-action button. 

The :key binding is used to provide a unique identifier for each item in the v-for loop. The template includes a comment reminding the developer to update the HTML tag classes to use Tailwind utility classes for styling. 

Overall, this template provides a simple yet effective way to display a collection of images with related text content in a responsive grid.

## Question

make the content come from a json array.  the img src should be a paremeter the first text is title the second is subtitle and the button text and link should be parameters as well.

## Answer

Sure! Here's an updated Vue.js template that retrieves the image source, title, subtitle, and button text/link from a JSON array using props:

```
<template>
  <!--
    This example requires updating your template:

    ```
    <html class="h-full bg-gray-50">
    <body class="h-full">
    ```
  -->
  <div 
    v-for="(item, index) in items"
    :key="index"
    class="grid min-h-full"
  >
    <div class="relative flex h-96">
      <img :src="item.imageSrc" alt="" class="absolute inset-0 h-full w-full object-cover object-center" />
      <div class="relative flex w-full flex-col items-start justify-end bg-black bg-opacity-40 p-8 sm:p-12">
        <h2 class="text-lg font-medium text-white text-opacity-75">{{ item.title }}</h2>
        <p class="mt-1 text-2xl font-medium text-white">{{ item.subtitle }}</p>
        <a :href="item.buttonLink" class="mt-4 rounded-md bg-white py-2.5 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50">{{ item.buttonText }}</a>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    items: {
      type: Array,
      required: true,
      default: () => []
    }
  }
}
</script>
```

To use this template, you can pass an array of objects to the `items` prop, where each object contains the image source, title, subtitle, button text, and button link for each item:

```
<template>
  <MyComponent :items="[
    {
      imageSrc: 'https://tailwindui.com/img/ecommerce-images/home-page-02-edition-01.jpg',
      title: 'Self-Improvement',
      subtitle: 'Journals and note-taking',
      buttonText: 'Shop now',
      buttonLink: '#'
    },
    {
      imageSrc: 'https://tailwindui.com/img/ecommerce-images/home-page-02-edition-02.jpg',
      title: 'Healthy Living',
      subtitle: 'Kitchen essentials and more',
      buttonText: 'Explore products',
      buttonLink: '#'
    }
  ]" />
</template>
```

In this example, the template generates two instances of the image grid, each with different content.

## Question

great. now update the component so that the image only shows as a fallback. by default the background should be a vimeo video using an iframe


## Answer

Sure, here's an updated Vue.js template that uses a Vimeo video as the background with an image fallback for browsers that don't support the video. The image source, title, subtitle, and button text/link are still retrieved from the JSON array using props:

```
<template>
  <div 
    v-for="(item, index) in items"
    :key="index"
    class="grid min-h-full"
  >
    <div class="relative flex h-96">
      <div v-if="!supportsVideo()" class="absolute inset-0 h-full w-full object-cover object-center" :style="{ backgroundImage: 'url(' + item.imageSrc + ')' }"></div>
      <div v-else>
        <iframe
          :src="getVideoSrc(item.videoId)"
          frameborder="0"
          webkitallowfullscreen
          mozallowfullscreen
          allowfullscreen
          class="absolute inset-0 h-full w-full"
        ></iframe>
      </div>
      <div class="relative flex w-full flex-col items-start justify-end bg-black bg-opacity-40 p-8 sm:p-12">
        <h2 class="text-lg font-medium text-white text-opacity-75">{{ item.title }}</h2>
        <p class="mt-1 text-2xl font-medium text-white">{{ item.subtitle }}</p>
        <a :href="item.buttonLink" class="mt-4 rounded-md bg-white py-2.5 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50">{{ item.buttonText }}</a>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    items: {
      type: Array,
      required: true,
      default: () => []
    }
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
```

The `supportsVideo()` method checks whether the browser supports the HTML5 `<video>` tag. If not, the image source is used as the background instead. The `getVideoSrc(videoId)` method generates the Vimeo video URL with the specified video ID and autoplay, loop, and other options. 

To use this updated template, you can pass the video ID and other information for each item in the JSON array:

```
<template>
  <MyComponent :items="[
    {
      videoId: '123456789',
      imageSrc: 'https://tailwindui.com/img/ecommerce-images/home-page-02-edition-01.jpg',
      title: 'Self-Improvement',
      subtitle: 'Journals and note-taking',
      buttonText: 'Shop now',
      buttonLink: '#'
    },
    {
      videoId: '987654321',
      imageSrc: 'https://tailwindui.com/img/ecommerce-images/home-page-02-edition-02.jpg',
      title: 'Healthy Living',
      subtitle: 'Kitchen essentials and more',
      buttonText: 'Explore products',
      buttonLink: '#'
    }
  ]" />
</template>
```

In this example, the template generates two instances of the video/image grid, each with different content and a Vimeo video background.
