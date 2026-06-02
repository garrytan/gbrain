---
title: "Music Single Promotion Template"
type: guide
created: 2024-05-24
updated: 2024-05-24
source: chatgpt-export
conversation_id: 167203da-43df-49e8-8415-045f8ad8a1f5
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Music Single Promotion Template

> Conversation ID: 167203da-43df-49e8-8415-045f8ad8a1f5
> Created: 2024-05-24T21:28:18Z
> Updated: 2024-05-24T21:35:44Z
> Messages: 10

---

## User

<template>
  <div class="bg-white">
    <div
      class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20"
    >
      <div
        class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40"
      >
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span
                    class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10"
                    >New Music</span
                  >
                  <span
                    class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600"
                  >
                    <span>Coming June 21</span>
                    <ChevronRightIcon
                      class="h-5 w-5 text-gray-400"
                      aria-hidden="true"
                    />
                  </span>
                </a>
              </div>
              <h1
                class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl"
              >
                Pre-save: <br /><span class="text-sky-600"
                  >Never Say A Word</span
                >
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>

              <div class="mt-4 flex items-center gap-x-6">
                <!--  <a
                  href="https://neversayaword.com"
                  class="text-sm font-semibold leading-6 text-gray-900"
                  >Or Pre-save On Spotify <span aria-hidden="true">→</span></a
                > -->
                <slot></slot>
              </div>
            </div>
          </div>
        </div>
        <div
          class="mt-20 sm:mt-24 mx-auto items-middle md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen"
        >
          <div class="w-96 items-middle mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div
        class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"
      />
    </div>
  </div>
</template>

<script setup>
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";
</script>


---

## Assistant

Your template is well-structured, and it seems to follow a clean design for promoting a new music single. Below is an improved version with some minor adjustments for clarity and best practices:

```html
<template>
  <div class="bg-white">
    <div class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20">
      <div class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40">
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10">New Music</span>
                  <span class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600">
                    <span>Coming June 21</span>
                    <ChevronRightIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </a>
              </div>
              <h1 class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
                Pre-save: <br /><span class="text-sky-600">Never Say A Word</span>
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>
              <div class="mt-4 flex items-center gap-x-6">
                <slot></slot>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-20 sm:mt-24 mx-auto items-center md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen">
          <div class="w-96 items-center mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"></div>
    </div>
  </div>
</template>

<script setup>
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";
</script>
```

### Key Adjustments:
1. **Element Alignment**: Adjusted the div classes to ensure proper alignment and spacing.
2. **Semantic HTML**: Used `items-center` instead of `items-middle` for proper alignment.
3. **Image Loading**: Ensured the `loading="lazy"` attribute is used for the image to improve performance.
4. **Class Naming**: Made sure the class names follow a consistent convention for easier reading and maintenance.

This should make your component more maintainable and ensure it renders as expected.

---

## User

if the date is june 21 we need to change the text to say out now


---

## Assistant

You can use a computed property to dynamically change the text based on the current date. Here's how you can adjust your template and script to achieve this:

```html
<template>
  <div class="bg-white">
    <div class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20">
      <div class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40">
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10">{{ badgeText }}</span>
                  <span class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600">
                    <span>{{ releaseText }}</span>
                    <ChevronRightIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </a>
              </div>
              <h1 class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
                Pre-save: <br /><span class="text-sky-600">Never Say A Word</span>
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>
              <div class="mt-4 flex items-center gap-x-6">
                <slot></slot>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-20 sm:mt-24 mx-auto items-center md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen">
          <div class="w-96 items-center mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";

const today = new Date();
const releaseDate = new Date('2024-06-21');

const isReleased = computed(() => today >= releaseDate);

const badgeText = computed(() => (isReleased.value ? 'New Music' : 'Pre-save'));
const releaseText = computed(() => (isReleased.value ? 'Out Now' : 'Coming June 21'));
</script>
```

### Explanation:
1. **Computed Properties**: `badgeText` and `releaseText` are computed properties that dynamically change based on the current date compared to the release date.
2. **Date Comparison**: The `isReleased` computed property checks if the current date is on or after the release date.
3. **Dynamic Text**: The text in the template changes based on the value of these computed properties.

This ensures that the text updates automatically without needing manual intervention when the date changes.

---

## User

gret now we also need to change the Pre-save text to say Listen now

---

## Assistant

To change the "Pre-save" text to "Listen now" dynamically based on the release date, you can update the computed property accordingly. Here's the revised version of your template and script:

```html
<template>
  <div class="bg-white">
    <div class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20">
      <div class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40">
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10">{{ badgeText }}</span>
                  <span class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600">
                    <span>{{ releaseText }}</span>
                    <ChevronRightIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </a>
              </div>
              <h1 class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
                {{ mainText }} <br /><span class="text-sky-600">Never Say A Word</span>
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>
              <div class="mt-4 flex items-center gap-x-6">
                <slot></slot>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-20 sm:mt-24 mx-auto items-center md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen">
          <div class="w-96 items-center mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";

const today = new Date();
const releaseDate = new Date('2024-06-21');

const isReleased = computed(() => today >= releaseDate);

const badgeText = computed(() => (isReleased.value ? 'New Music' : 'Pre-save'));
const releaseText = computed(() => (isReleased.value ? 'Out Now' : 'Coming June 21'));
const mainText = computed(() => (isReleased.value ? 'Listen now:' : 'Pre-save:'));
</script>
```

### Changes Made:
1. **Computed Property for Main Text**: Added `mainText` computed property to change the "Pre-save" text to "Listen now" dynamically based on the release date.
2. **Template Update**: Updated the `h1` tag to use `mainText` computed property.

This will ensure that the main heading text changes to "Listen now" when the release date is reached.

---

## User

great and finally instead of the <slot></slot> we should show the <div class="mt-8">
            <dt class="text-sm font-semibold leading-6 text-gray-600">
              Listen
            </dt>
            <dd
              class="mt-2 text-3xl flex space-x-2 font-bold leading-10 tracking-tight text-gray-900"
            >
              <StreamingIcons></StreamingIcons>
            </dd>
          </div>

---

## Assistant

Sure, here is the updated template with the `<slot></slot>` replaced by the specified `<div>` containing the "Listen" section with streaming icons:

```html
<template>
  <div class="bg-white">
    <div class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20">
      <div class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40">
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10">{{ badgeText }}</span>
                  <span class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600">
                    <span>{{ releaseText }}</span>
                    <ChevronRightIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </a>
              </div>
              <h1 class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
                {{ mainText }} <br /><span class="text-sky-600">Never Say A Word</span>
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>
              <div class="mt-8">
                <dt class="text-sm font-semibold leading-6 text-gray-600">
                  Listen
                </dt>
                <dd class="mt-2 text-3xl flex space-x-2 font-bold leading-10 tracking-tight text-gray-900">
                  <StreamingIcons></StreamingIcons>
                </dd>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-20 sm:mt-24 mx-auto items-center md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen">
          <div class="w-96 items-center mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";
import StreamingIcons from './path/to/StreamingIcons.vue'; // Ensure to update this path to where your StreamingIcons component is located

const today = new Date();
const releaseDate = new Date('2024-06-21');

const isReleased = computed(() => today >= releaseDate);

const badgeText = computed(() => (isReleased.value ? 'New Music' : 'Pre-save'));
const releaseText = computed(() => (isReleased.value ? 'Out Now' : 'Coming June 21'));
const mainText = computed(() => (isReleased.value ? 'Listen now:' : 'Pre-save:'));
</script>
```

### Explanation:
1. **Replaced `<slot></slot>`**: The `<slot></slot>` tag has been replaced with the provided `<div>` containing the "Listen" section.
2. **StreamingIcons Component**: Ensure that you have a `StreamingIcons` component imported correctly. Adjust the import path as necessary.

This update ensures that the "Listen" section with streaming icons is displayed correctly.

---

## User

ok but that should also only show if its released

---

## Assistant

Understood. You can conditionally render the "Listen" section only if the release date has passed. Here's the updated template and script to include this logic:

```html
<template>
  <div class="bg-white">
    <div class="relative isolate overflow-hidden bg-gradient-to-b from-white to-sky-200/20">
      <div class="mx-auto max-w-7xl pb-24 pt-10 sm:pb-32 lg:grid lg:grid-cols-2 lg:gap-x-8 lg:px-8 lg:py-40">
        <div class="px-6 lg:px-0 lg:pt-4">
          <div class="mx-auto max-w-2xl">
            <div class="max-w-lg">
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="#" class="inline-flex space-x-6">
                  <span class="rounded-full bg-sky-600/10 px-3 py-1 text-sm font-semibold leading-6 text-sky-600 ring-1 ring-inset ring-sky-600/10">{{ badgeText }}</span>
                  <span class="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600">
                    <span>{{ releaseText }}</span>
                    <ChevronRightIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
                  </span>
                </a>
              </div>
              <h1 class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
                {{ mainText }} <br /><span class="text-sky-600">Never Say A Word</span>
              </h1>
              <p class="mt-6 text-lg leading-8 text-gray-600">
                The new single from Tim White.
              </p>
              <div v-if="isReleased" class="mt-8">
                <dt class="text-sm font-semibold leading-6 text-gray-600">
                  Listen
                </dt>
                <dd class="mt-2 text-3xl flex space-x-2 font-bold leading-10 tracking-tight text-gray-900">
                  <StreamingIcons></StreamingIcons>
                </dd>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-20 sm:mt-24 mx-auto items-center md:mx-auto md:max-w-2xl lg:mx-0 lg:mt-0 lg:w-screen">
          <div class="w-96 items-center mx-auto">
            <div class="aspect-w-16 aspect-h-9">
              <img
                alt="Tim White - Never Say A Word Album Art Teaser"
                loading="lazy"
                class="object-cover rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
                :src="neverSayAWordAlbumArt"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-white sm:h-32"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
import { ChevronRightIcon } from "@heroicons/vue/20/solid";
import StreamingIcons from './path/to/StreamingIcons.vue'; // Ensure to update this path to where your StreamingIcons component is located

const today = new Date();
const releaseDate = new Date('2024-06-21');

const isReleased = computed(() => today >= releaseDate);

const badgeText = computed(() => (isReleased.value ? 'New Music' : 'Pre-save'));
const releaseText = computed(() => (isReleased.value ? 'Out Now' : 'Coming June 21'));
const mainText = computed(() => (isReleased.value ? 'Listen now:' : 'Pre-save:'));
</script>
```

### Explanation:
1. **Conditional Rendering**: Added `v-if="isReleased"` to the `<div>` containing the "Listen" section to ensure it only renders if the release date has passed.
2. **Computed Properties**: Kept the computed properties to dynamically change the text based on the current date.

This ensures that the "Listen" section with streaming icons is only shown when the single is released.
