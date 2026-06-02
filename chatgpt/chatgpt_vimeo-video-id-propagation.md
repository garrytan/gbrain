---
title: "Vimeo Video ID Propagation."
type: note
created: 2023-02-27
updated: 2023-02-27
source: chatgpt-export
conversation_id: 47a292ea-f547-4a8a-8433-8337697644cb
message_count: 2
tags: [chatgpt, import]
---
# Vimeo Video ID Propagation.

> Conversation ID: 47a292ea-f547-4a8a-8433-8337697644cb
> Created: 2023-02-27T05:25:35Z
> Updated: 2023-02-27T05:25:35Z
> Messages: 2

---

## User

<template>
  <iframe
    src="https://player.vimeo.com/video/238149344?h=848f996d00"
    width="640"
    height="253"
    frameborder="0"
    allow="autoplay; fullscreen; picture-in-picture"
    allowfullscreen
  ></iframe>
  <p>
    <a href="https://vimeo.com/238149344">CITY 2016</a> from
    <a href="https://vimeo.com/rtragnone">Reinaldo Tragnone</a> on
    <a href="https://vimeo.com">Vimeo</a>.
  </p>
</template>
replace the video id with a variable and prop

---

## Assistant

Assuming that you want to replace the video ID with a variable and pass it as a prop, you could do something like this:

<template>
  <iframe
    :src="`https://player.vimeo.com/video/${videoId}?h=848f996d00`"
    width="640"
    height="253"
    frameborder="0"
    allow="autoplay; fullscreen; picture-in-picture"
    allowfullscreen
  ></iframe>
  <p>
    <a :href="`https://vimeo.com/${videoId}`">CITY 2016</a> from
    <a href="https://vimeo.com/rtragnone">Reinaldo Tragnone</a> on
    <a href="https://vimeo.com">Vimeo</a>.
  </p>
</template>

Then, in the component where you're using this template, you could pass a prop called `videoId` with the value of the Vimeo video ID you want to display:

<template>
  <div>
    <VideoPlayer :videoId="238149344" />
  </div>
</template> 

Note: Make sure to import the `VideoPlayer` component and register it in the parent component before using it.


## See Also
- [[chatgpt/chatgpt_dns-propagation-check-part1]]
- [[chatgpt/chatgpt_dns-propagation-check-part2]]
- [[chatgpt/chatgpt_dns-propagation-check-part3]]
- [[chatgpt/chatgpt_dns-propagation-check-part4]]
- [[chatgpt/chatgpt_dns-propagation-time]]
