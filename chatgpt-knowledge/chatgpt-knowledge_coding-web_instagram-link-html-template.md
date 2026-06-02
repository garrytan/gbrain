---
title: "Instagram Link HTML Template"
type: guide
created: 2024-05-24
updated: 2024-05-24
source: chatgpt-export
topic: coding-web
message_count: 10
tags: [chatgpt, knowledge, coding-web]
---
# Instagram Link HTML Template

> **Source:** ChatGPT conversation
> **Date:** 2024-05-24T19:35:27Z
> **Messages:** 10
> **Topic:** coding-web

## Question

<template>
  <div class="flex">
    <a
      href="https://instagram.com/timwhite"
      target="_blank"
      rel="noopener noreferrer"
      class="hover:text-gray-600 mx-2"
      ><svg
        class="h-6 w-6 text-gray-600 hover:text-gray-800"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <title>Instagram</title>
        <path
          d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.

## Answer

Here is the updated HTML template:

```html
<div class="flex">
  <a
    href="https://instagram.com/timwhite"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Instagram</title>
      <path
        d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"
      />
    </svg>
  </a>
  <a
    href="https://youtube.com/timwhite"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>YouTube</title>
      <path
        d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-

*(Answer truncated — 3901 chars total)*

## Question

ok we need to add links for all of tim whites music streaming profiles. here we go:

https://www.deezer.com/us/artist/1672092
https://music.youtube.com/channel/UCjJ-tn5dij5FuxR1p4ikDRQ
https://www.pandora.com/artist/tim-white/AR7k2xlgmVzbZ9q?part=ag&corr=QVI6NTI0NDEyX0FSOjUyNDQxMl9CQUNLU1RfUFJPRg%3D%3D&_branch_match_id=749411182838621736


## Answer

Here is the updated HTML template with the added links:

```html
<div class="flex">
  <a
    href="https://instagram.com/timwhite"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Instagram</title>
      <path
        d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"
      />
    </svg>
  </a>
  <a
    href="https://youtube.com/timwhite"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>YouTube</title>
      <path
        d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.9

*(Answer truncated — 3915 chars total)*

## Answer

12.225c-.051 0-.094.046-.101.1l-.233 2.154.233 2.105c.007.058.05.098.101.098.05 0 .09-.04.099-.098l.255-2.105-.27-2.154c0-.057-.045-.1-.09-.1m-.899.828c-.06 0-.091.037-.104.094L0 14.479l.165 1.308c0 .055.045.094.09.094s.089-.045.104-.104l.21-1.319-.21-1.334c0-.061-.044-.09-.09-.09m1.83-1.229c-.061 0-.12.045-.12.104l-.21 2.563.225 2.458c0 .06.045.12.119.12.061 0 .105-.061.121-.12l.254-2.474-.254-2.548c-.016-.06-.061-.12-.121-.12m.945-.089c-.075 0-.135.06-.15.135l-.193 2.64.21 2.544c.016.077.075.138.149.138.075 0 .135-.061.15-.15l.24-2.532-.24-2.623c0-.075-.06-.135-.135-.135l-.031-.017zm1.155.36c-.005-.09-.075-.149-.159-.149-.09 0-.158.06-.164.149l-.217 2.43.2 2.563c0 .09.075.157.159.157.074 0 .148-.068.148-.158l.227-2.563-.227-2.444.033.015zm.809-1.709c-.101 0-.18.09-.18.181l-.21 3.957.187 2.563c0 .09.08.164.18.164.094 0 .174-.09.18-.18l.209-2.563-.209-3.972c-.008-.104-.088-.18-.18-.18m.959-.914c-.105 0-.195.09-.203.194l-.18 4.872.165 2.548c0 .12.09.209.195.209.104 0 .194-.089.21-.209l.193-2.548-.192-4.856c-.016-.12-.105-.21-.21-.21m.989-.449c-.121 0-.211.089-.225.209l-.165 5.275.165 2.52c.014.119.104.225.225.225.119 0 .225-.105.225-.225l.195-2.52-.196-5.275c0-.12-.105-.225-.225-.225m1.245.045c0-.135-.105-.24-.24-.24-.119 0-.24.105-.24.24l-.149 5.441.149 2.503c.016.135.121.24.256.24s.24-.105.24-.24l.164-2.503-.164-5.456-.016.015zm.749-.134c-.135 0-.255.119-.255.254l-.15 5.322.15 2.473c0 .15.12.255.255.255s.255-.12.255-.27l.15-2.474-.165-5.307c0-.148-.12-.27-.271-.27m1.005.166c-.164 0-.284.135-.284.285l-.103 5.143.135 2.474c0 .149.119.277.284.277.149 0 .271-.12.284-.285l.121-2.443-.135-5.112c-.012-.164-.135-.285-.285-.285m1.184-.945c-.045-.029-.105-.044-.165-.044s-.119.015-.165.044c-.09.054-.149.15-.149.255v.061l-.104 6.048.115 2.449v.008c.008.06.03.135.074.18.058.061.142.104.234.104.08 0 .158-.044.209-.09.058-.06.091-.135.091-.225l.015-.24.117-2.203-.135-6.086c0-.104-.061-.193-.135-.239l-.002-.022zm1.006-.547c-.045-.045-.09-.061-.15-.061-.074 0-.149.016-.209.061-.075.061-.119.15-.119.24v.029l-.137 6.609.076 1.215.061 1.185c0 .164.148.314.328.314.181 0 .33-.15.33-.329l.15-2.414-.15-6.637c0-.12-.074-.221-.165-.277m8.934 3.777c-.405 0-.795.086-1.139.232-.24-2.654-2.46-4.736-5.188-4.736-.659 0-1.305.135-1.889.359-.225.09-.27.18-.285.359v9.368c.016.18.15.33.33.345h8.185C22.681 17.218 24 15.914 24 14.28s-1.319-2.952-2.938-2.952"
      />
    </svg>
  </a>
  <a
    href="https://open.spotify.com/artist/4Uwpa6zW3zzCSQvooQNksm"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Spotify</title>
      <path
        d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-

*(Answer truncated — 3840 chars total)*

## Answer

54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
      />
    </svg>
  </a>
  <a
    href="https://www.deezer.com/us/artist/1672092"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Deezer</title>
      <path
        d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"
      />
    </svg>
  </a>
  <a
    href="https://music.youtube.com/channel/UCjJ-tn5dij5FuxR1p4ikDRQ"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>YouTube Music</title>
      <path
        d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"
      />
    </svg>
  </a>
  <a
    href="https://www.pandora.com/artist/tim-white/AR7k2xlgmVzbZ9q?part=ag&corr=QVI6NTI0NDEyX0FSOjUyNDQxMl9CQUNLU1RfUFJPRg%3D%3D&_branch_match_id=749411182838621736"
    target="_blank"
    rel="noopener noreferrer"
    class="hover:text-gray-600 mx-2"
  >
    <svg
      class="h-6 w-6 text-gray-600 hover:text-gray-800"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <title>Pandora</title>
      <path
        d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.47

*(Answer truncated — 3347 chars total)*

## Question

sorry i put the wrong template. here it is

<template>
  <div class="flex space-x-4 justify-around items-center">
    <a
      v-for="service in musicServices"
      :key="service.name"
      :href="service.url"
      :title="service.name"
      class="opacity-50"
    >
      <img :src="service.icon" :alt="service.name" class="h-6" />
    </a>
  </div>
</template>

<script>
// Importing the SVG icons from the assets directory using relative paths
import spotifyIcon from "../assets/icons/spotify.svg";
import appleMusicIcon from "../assets/icons/applemusic.svg";

import amazonMusicIcon from "../assets/icons/amazonmusic.svg";
import soundcloudIcon from "../assets/icons/soundcloud.svg";

export default {
  name: "MusicServiceLinks",
  data() {
    return {
      musicServices: [
        {
          name: "Spotify",
          url: "https://open.spotify.com/artist/4Uwpa6zW3zzCSQvooQNksm",
          icon: spotifyIcon,
        },
        {
          name: "Apple Music",
          url: "https:/

## Answer

Here is the updated template with the additional music streaming profiles:

```html
<template>
  <div class="flex space-x-4 justify-around items-center">
    <a
      v-for="service in musicServices"
      :key="service.name"
      :href="service.url"
      :title="service.name"
      class="opacity-50"
    >
      <img :src="service.icon" :alt="service.name" class="h-6" />
    </a>
  </div>
</template>

<script>
// Importing the SVG icons from the assets directory using relative paths
import spotifyIcon from "../assets/icons/spotify.svg";
import appleMusicIcon from "../assets/icons/applemusic.svg";
import amazonMusicIcon from "../assets/icons/amazonmusic.svg";
import soundcloudIcon from "../assets/icons/soundcloud.svg";
import deezerIcon from "../assets/icons/deezer.svg";
import youtubeMusicIcon from "../assets/icons/youtubemusic.svg";
import pandoraIcon from "../assets/icons/pandora.svg";

export default {
  name: "MusicServiceLinks",
  data() {
    return {
      musicServices: [
        {
          name: "Spotify",
          url: "https://open.spotify.com/artist/4Uwpa6zW3zzCSQvooQNksm",
          icon: spotifyIcon,
        },
        {
          name: "Apple Music",
          url: "https://music.apple.com/us/artist/tim-white/859547284",
          icon: appleMusicIcon,
        },
        {
          name: "Amazon Music",
          url: "https://www.amazon.com/music/player/artists/B000QK56I0/tim-white",
          icon: amazonMusicIcon,
        },
        {
          name: "Soundcloud",
          url: "https://soundcloud.com/itstimwhite",
          icon: soundcloudIcon,
        },
        {
          name: "Deezer",
          url: "https://www.deezer.com/us/artist/1672092",
          icon: deezerIcon,
        },
        {
          name: "YouTube Music",
          url: "https://music.youtube.com/channel/UCjJ-tn5dij5FuxR1p4ikDRQ",
          icon: youtubeMusicIcon,
        },
        {
          name: "Pandora",
          url: "https://www.pandora.com/artist/tim-white/AR7k2xlgmVzbZ9q?part=ag&corr=QVI6NTI0NDEyX0FSOjUyNDQxMl9CQUNLU1RfUFJPRg%3D%3D&_branch_match_id=749411182838621736",
          icon: pandoraIcon,
        },
      ],
    };
  },
};
</script>
```

In this template, I've added the Deezer, YouTube Music, and Pandora links, and included placeholders for their respective icons. Make sure you have the SVG icons for these services in your assets directory and update the import paths if necessary.

## Question

<template>
  <div class="flex space-x-4 justify-around items-center">
    <a
      v-for="service in musicServices"
      :key="service.name"
      :href="service.url"
      :title="service.name"
      class="opacity-50"
    >
      <img :src="service.icon" :alt="service.name" class="h-6" />
    </a>
  </div>
</template>

lets add an animation to scale the icon slightly on hover


## Answer

Here is the updated template with an animation to scale the icon slightly on hover:

```html
<template>
  <div class="flex space-x-4 justify-around items-center">
    <a
      v-for="service in musicServices"
      :key="service.name"
      :href="service.url"
      :title="service.name"
      class="opacity-50 hover:opacity-100 transform transition-transform duration-200 hover:scale-110"
    >
      <img :src="service.icon" :alt="service.name" class="h-6" />
    </a>
  </div>
</template>

<script>
// Importing the SVG icons from the assets directory using relative paths
import spotifyIcon from "../assets/icons/spotify.svg";
import appleMusicIcon from "../assets/icons/applemusic.svg";
import amazonMusicIcon from "../assets/icons/amazonmusic.svg";
import soundcloudIcon from "../assets/icons/soundcloud.svg";
import deezerIcon from "../assets/icons/deezer.svg";
import youtubeMusicIcon from "../assets/icons/youtubemusic.svg";
import pandoraIcon from "../assets/icons/pandora.svg";

export default {
  name: "MusicServiceLinks",
  data() {
    return {
      musicServices: [
        {
          name: "Spotify",
          url: "https://open.spotify.com/artist/4Uwpa6zW3zzCSQvooQNksm",
          icon: spotifyIcon,
        },
        {
          name: "Apple Music",
          url: "https://music.apple.com/us/artist/tim-white/859547284",
          icon: appleMusicIcon,
        },
        {
          name: "Amazon Music",
          url: "https://www.amazon.com/music/player/artists/B000QK56I0/tim-white",
          icon: amazonMusicIcon,
        },
        {
          name: "Soundcloud",
          url: "https://soundcloud.com/itstimwhite",
          icon: soundcloudIcon,
        },
        {
          name: "Deezer",
          url: "https://www.deezer.com/us/artist/1672092",
          icon: deezerIcon,
        },
        {
          name: "YouTube Music",
          url: "https://music.youtube.com/channel/UCjJ-tn5dij5FuxR1p4ikDRQ",
          icon: youtubeMusicIcon,
        },
        {
          name: "Pandora",
          url: "https://www.pandora.com/artist/tim-white/AR7k2xlgmVzbZ9q?part=ag&corr=QVI6NTI0NDEyX0FSOjUyNDQxMl9CQUNLU1RfUFJPRg%3D%3D&_branch_match_id=749411182838621736",
          icon: pandoraIcon,
        },
      ],
    };
  },
};
</script>

<style scoped>
a:hover {
  opacity: 1 !important;
}
</style>
```

In this update, I've added the `hover:opacity-100 transform transition-transform duration-200 hover:scale-110` classes to the `<a>` elements to achieve the desired hover effect. The `style scoped` block ensures that the hover opacity rule is applied correctly.
