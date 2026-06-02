---
title: "Vue.js iframe creation."
type: note
created: 2023-03-01
updated: 2023-03-01
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Vue.js iframe creation.

> **Source:** ChatGPT conversation
> **Date:** 2023-03-01T03:38:42Z
> **Messages:** 6
> **Topic:** coding-web

## Question

 <iframe 
      v-else
      title="Videos"
      :src="getVideoSrc(videoId)"
      webkitallowfullscreen
      class="h-96 w-full justify-end"
      mozallowfullscreen
      allowfullscreen

      controls
    >
    </iframe>

## Answer

This appears to be a code snippet in Vue.js, which is a JavaScript framework for building user interfaces. The code creates an HTML iframe element with various attributes such as title, source URL, and allowfullscreen. The source URL is dynamically generated using the videoId parameter passed to the getVideoSrc() function. The iframe is also given a class of "h-96 w-full justify-end" which likely sets the height, width, and alignment of the iframe. Additionally, the "controls" attribute is included to display standard media controls such as play/pause, volume, and progress bar.

## Question

change the iframe to a normal embed with video controls

## Answer

Sure, here's an example of how to replace the iframe with a standard video embed using HTML5 video element:

```
<video controls width="100%">
  <source :src="getVideoSrc(videoId)" type="video/mp4">
  Your browser does not support the video tag.
</video>
```

In this example, the `controls` attribute enables the standard media controls. The `width` attribute sets the width of the video element to 100% of its container. The `source` element specifies the source URL of the video, which is generated dynamically using the `getVideoSrc()` method.

Note that in this example, we assume that the video source is in MP4 format. You may need to adjust the `type` attribute accordingly if your video is in a different format.

## Question

im using vimeo videos so it should be specific to that

## Answer

Got it! Here's an example of how to embed a Vimeo video with video controls using the `iframe` embed code provided by Vimeo:

```
<iframe
  src="https://player.vimeo.com/video/{{ videoId }}?title=0&byline=0&portrait=0&badge=0&autopause=0&player_id=0&app_id=58479"
  width="100%"
  height="360"
  frameborder="0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>
```

In this example, we use the Vimeo `iframe` embed code and replace the `{{ videoId }}` placeholder with the actual ID of the Vimeo video we want to embed. The `title`, `byline`, `portrait`, and `badge` parameters are set to 0 to hide these elements from the video player. The `autopause`, `player_id`, and `app_id` parameters are also set to 0 to disable auto-pause and avoid conflicts with other Vimeo embeds on the same page.

The `allow` attribute specifies the permissions granted to the embedded video, such as autoplay and picture-in-picture. Finally, the `allowfullscreen` attribute enables the video to be played in full screen mode.

Note that this example assumes a video height of 360 pixels, but you can adjust this value as needed to match the aspect ratio of your video.
