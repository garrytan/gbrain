---
title: "Apple-style RSVP Button"
type: note
created: 2024-02-27
updated: 2024-02-27
source: chatgpt-export
conversation_id: 43706de6-76bf-46e0-919d-8b291b9af2da
message_count: 2
tags: [chatgpt, import, code]
---
# Apple-style RSVP Button

> Conversation ID: 43706de6-76bf-46e0-919d-8b291b9af2da
> Created: 2024-02-27T01:03:21Z
> Updated: 2024-02-27T01:03:38Z
> Messages: 2

---

## User

<template>
  <div class="flex-grow flex items-center justify-center">
    <Container>
      <div class="text-center font-bold text-black">
        <div class="border-b text-lg w-full">Tim White on Tour</div>

        <div class="font-medium text-sm text-slate-500 mt-4">
          SORRY, THERE ARE NO SHOWS CURRENTLY AVAILABLE. TO BE NOTIFIED OF NEW
          TOUR DATES WHEN THEY ARE ANNOUNCED, CLICK THE RSVP LINK BELOW.
        </div>
      </div>
    </Container>
  </div>
</template>
<script>
export default {
  name: "Home",
};
</script>
sentence case the text and add a button for rsvp. style it simple and minimal like an apple website button. have it go to this page:
https://www.bandsintown.com/artist-subscribe/946944?utm_campaign=track&utm_medium=web&app_id=umg_Interscope_MachineGunKelly&affil_code=umg_US&utm_source=public_api&came_from=267&spn=0&signature=ZZf021f83963f66d54e3974140fb8275cc7d260ebaf1815f8837e514860fa7ed33&waitlist=false

---

## Assistant

To achieve a minimal and Apple-like design for your website section, follow this updated HTML structure with embedded CSS for styling. The button for RSVP will be styled to match the simple and minimal aesthetic typical of Apple's design language, leading to the provided link when clicked.

```html
<div class="flex-grow flex items-center justify-center">
  <Container>
    <div class="text-center font-bold text-black">
      <div class="border-b text-lg w-full">Tim White on tour</div>

      <div class="font-medium text-sm text-slate-500 mt-4">
        Sorry, there are no shows currently available. To be notified of new tour dates when they are announced, click the RSVP link below.
      </div>
      
      <a href="https://www.bandsintown.com/artist-subscribe/946944?utm_campaign=track&utm_medium=web&app_id=umg_Interscope_MachineGunKelly&affil_code=umg_US&utm_source=public_api&came_from=267&spn=0&signature=ZZf021f83963f66d54e3974140fb8275cc7d260ebaf1815f8837e514860fa7ed33&waitlist=false" target="_blank" rel="noopener noreferrer" class="rsvp-button">RSVP</a>
    </div>
  </Container>
</div>

<style>
  .rsvp-button {
    display: inline-block;
    margin-top: 20px;
    padding: 10px 20px;
    background-color: black;
    color: white;
    font-weight: bold;
    text-decoration: none;
    border-radius: 20px;
    transition: background-color 0.3s ease;
  }
  
  .rsvp-button:hover {
    background-color: #555;
  }
</style>
```

This code snippet includes a styled button labeled "RSVP" that links to the specified URL. The button's style is straightforward, featuring a black background with white text, rounded corners, and a gentle hover effect to enhance user interaction, embodying the simplicity and elegance of Apple's design ethos.


## See Also
- [[chatgpt/chatgpt_apple-music-style-guide-part1]]
- [[chatgpt/chatgpt_apple-music-style-guide-part2]]
- [[chatgpt/chatgpt_apple-music-style-guide-part3]]
- [[chatgpt/chatgpt_format-lyrics-apple-style]]
- [[chatgpt/chatgpt_style-sky-button-tailwind]]
