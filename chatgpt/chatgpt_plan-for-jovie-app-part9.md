
Let's break this down and ensure we have everything correctly set up for dynamic song and creator profiles with custom slugs. We'll refactor the components and pages to pull the necessary data from JSON files and ensure the correct dynamic routing.

### 1. Update JSON Data Structure

Let's define a JSON structure for creators and their songs, including custom slugs.

**creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "songs": {
      "nsaw": {
        "songTitle": "Never Say A Word",
        "albumArt": "img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01T00:00:00Z",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
          { "name": "Apple Music", "url": "", "icon": "applemusic.svg" },
          { "name": "YouTube Music", "url": "", "icon": "youtubemusic.svg" },
          { "name": "Pandora", "url": "", "icon": "pandora.svg" },
          { "name": "Audius", "url": "", "icon": "audius.svg" },
          { "name": "iHeartRadio", "url": "", "icon": "iheartradio.svg" },
          { "name": "Amazon Music", "url": "", "icon": "amazonmusic.svg" },
          { "name": "Soundcloud", "url": "", "icon": "soundcloud.svg" }
        ]
      }
    }
  }
}
```

### 2. Dynamic Song Page Component

Create a dynamic song page component under `pages/[creatorName]/[songSlug].vue`:

```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="songData.albumArt"
          :alt="songData.songTitle"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorName }}
        </h2>
      </div>

      <div class="text-center mx-auto mt-4" v-if="isFutureRelease">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Releases in: {{ countdown }}
        </h3>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ songData.songTitle }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ songData.description }}</p>
        </div>

        <!-- Options -->
        <div class="mt-10 text-center">
          <form class="mt-10">
            <div class="mt-10">
              <div class="flex items-center justify-center">
                <h3 class="text-sm font-medium text-gray-900">Listen on</h3>
              </div>
              <fieldset aria-label="Choose a music service" class="mt-4">
                <RadioGroup
                  v-model="selectedService"
                  class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3"
                >
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
                    v-if="service.url"
                    v-slot="{ active, checked }"
                  >
                    <div
                      :class="[
                        'cursor-pointer bg-white text-gray-900 shadow-sm',
                        active ? 'ring-2 ring-indigo-500' : '',
                        'group relative flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium uppercase hover:bg-gray-50 focus:outline-none',
                      ]"
                    >
                      <img
                        :src="`/icons/${service.icon}`"
                        :alt="service.name"
                        class="h-8 w-8"
                      />
                      <span
                        :class="[
                          active ? 'border' : 'border-2',
                          checked ? 'border-indigo-500' : 'border-transparent',
                          'pointer-events-none absolute -inset-px rounded-md',
                        ]"
                        aria-hidden="true"
                      />
                    </div>
                  </RadioGroupOption>
                </RadioGroup>
              </fieldset>
            </div>

            <a
              :href="selectedService.url"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </a>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const selectedService = ref({});
const creatorName = ref("");
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name;
  songData.value = creator.songs[route.params.songSlug] || {};
  selectedService.value = songData.value.services.find(service => service.url) || {};

  if (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorName.value} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });
});
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### 3. Routing Configuration

Ensure your `nuxt.config.js` is correctly set up to handle dynamic routes:

```javascript
export default {
  // Other configurations...
  generate: {
    routes: async () => {
      const response = await fetch("https://your-site.com/creators.json");
      const creators = await response.json();
      let routes = [];

      for (const creatorName in creators) {
        const creator = creators[creatorName];
        routes.push(`/${creatorName}`);
        for (const songSlug in creator.songs) {
          routes.push(`/${creatorName}/${songSlug}`);
        }
      }
      return routes;
    }
  }
}
```

### Summary

- **Dynamic Song Page:** A Vue component that displays song details dynamically based on the URL parameters.
- **JSON Data Source:** A structured JSON file that stores information about creators and their songs.
- **Dynamic Routing:** Configured in `nuxt.config.js` to generate routes dynamically based on the JSON data.

This setup ensures that you can manage creators and their songs easily from a single JSON file, and the app will dynamically create the necessary pages and routes.


Here's my nuxt config
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  
  devtools: { enabled: true },
  
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    // prerender index route by default
    '/': { prerender: true },
  },
  modules: ["@nuxtjs/seo", "@nuxt/image"],
  site: {
    url: 'https://jov.ie',
    name: 'Jovie',
    description: 'Instantly create music smart links and pre-save campaigns. Get your music heard on Spotify, Apple Music, TikTok, and more.',
    defaultLocale: 'en', // not needed if you have @nuxtjs/i18n installed
  },
  image: {
    // Options
  },
  
});


Given your `nuxt.config.js` setup, let's make sure we have everything ready for dynamically creating song and creator profiles. I'll walk you through ensuring the config, pages, and components are set up correctly.

### 1. JSON Data Structure

Let's update the JSON data structure for creators and their songs.

**creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "songs": {
      "nsaw": {
        "songTitle": "Never Say A Word",
        "albumArt": "img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01T00:00:00Z",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
          { "name": "Apple Music", "url": "https://music.apple.com/us/album/never-say-a-word/1234567890", "icon": "applemusic.svg" },
          { "name": "YouTube Music", "url": "https://music.youtube.com/playlist?list=PL1234567890", "icon": "youtubemusic.svg" },
          { "name": "Pandora", "url": "https://www.pandora.com/artist/tim-white/AR123456", "icon": "pandora.svg" },
          { "name": "Audius", "url": "https://audius.co/timwhite/never-say-a-word-123456", "icon": "audius.svg" },
          { "name": "iHeartRadio", "url": "https://www.iheart.com/artist/tim-white-123456", "icon": "iheartradio.svg" },
          { "name": "Amazon Music", "url": "https://music.amazon.com/albums/123456", "icon": "amazonmusic.svg" },
          { "name": "Soundcloud", "url": "https://soundcloud.com/timwhite/never-say-a-word", "icon": "soundcloud.svg" }
        ]
      }
    }
  }
}
```

### 2. Dynamic Song Page Component

Create a dynamic song page component under `pages/[creatorName]/[songSlug].vue`:

**pages/[creatorName]/[songSlug].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="songData.albumArt"
          :alt="songData.songTitle"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorName }}
        </h2>
      </div>

      <div class="text-center mx-auto mt-4" v-if="isFutureRelease">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Releases in: {{ countdown }}
        </h3>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ songData.songTitle }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ songData.description }}</p>
        </div>

        <!-- Options -->
        <div class="mt-10 text-center">
          <form class="mt-10">
            <div class="mt-10">
              <div class="flex items-center justify-center">
                <h3 class="text-sm font-medium text-gray-900">Listen on</h3>
              </div>
              <fieldset aria-label="Choose a music service" class="mt-4">
                <RadioGroup
                  v-model="selectedService"
                  class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3"
                >
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
                    v-if="service.url"
                    v-slot="{ active, checked }"
                  >
                    <div
                      :class="[
                        'cursor-pointer bg-white text-gray-900 shadow-sm',
                        active ? 'ring-2 ring-indigo-500' : '',
                        'group relative flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium uppercase hover:bg-gray-50 focus:outline-none',
                      ]"
                    >
                      <img
                        :src="`/icons/${service.icon}`"
                        :alt="service.name"
                        class="h-8 w-8"
                      />
                      <span
                        :class="[
                          active ? 'border' : 'border-2',
                          checked ? 'border-indigo-500' : 'border-transparent',
                          'pointer-events-none absolute -inset-px rounded-md',
                        ]"
                        aria-hidden="true"
                      />
                    </div>
                  </RadioGroupOption>
                </RadioGroup>
              </fieldset>
            </div>

            <a
              :href="selectedService.url"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </a>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const selectedService = ref({});
const creatorName = ref("");
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name;
  songData.value = creator.songs[route.params.songSlug] || {};
  selectedService.value = songData.value.services.find(service => service.url) || {};

  if (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorName.value} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });
});
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### 3. Routing Configuration

Ensure your `nuxt.config.js` is correctly set up to handle dynamic routes:

```javascript
export default defineNuxtConfig({
  devtools: { enabled: true },
  
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    // prerender index route by default
    '/': { prerender: true },
  },
  modules: ["@nuxtjs/seo", "@nuxt/image"],
  site: {
    url: 'https://jov.ie',
    name: 'Jovie',
    description: 'Instantly create music smart links and pre-save campaigns. Get your music heard on Spotify, Apple Music, TikTok, and more.',
    defaultLocale: 'en', // not needed if you have @nuxtjs/i18n installed
  },
  image: {
    // Options
  },
  generate: {
    routes: async () => {
      const response = await fetch("https://jov.ie/creators.json");
      const creators = await response.json();
      let routes = [];

      for (const creatorName in creators) {
        const creator = creators[creatorName];
        routes.push(`/${creatorName}`);
        for (const songSlug in creator.songs) {
          routes.push(`/${creatorName}/${songSlug}`);
        }
      }
      return routes;
    }
  }
});
```

### Summary

- **Dynamic Song Page:** A Vue component that displays song details dynamically based on the URL parameters.
- **JSON Data Source:** A structured JSON file that stores information about creators and their songs.
- **Dynamic Routing:** Configured in `nuxt.config.js` to generate routes dynamically based on the JSON data.

This setup ensures that



[10:43:59 PM]  ERROR  Pre-transform error: Failed to resolve import "../assets/icons/spotify.svg" from "components/StreamingIcons.vue". Does the file exist?


To resolve the error and ensure that the song component dynamically pulls data from JSON and handles the imports correctly, you need to update the paths and components properly. Here's the detailed setup:

### 1. JSON Data Structure

Ensure your JSON file is properly structured with valid URLs for each service.

**creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "songs": {
      "nsaw": {
        "songTitle": "Never Say A Word",
        "albumArt": "/img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01T00:00:00Z",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
          { "name": "Apple Music", "url": "https://music.apple.com/us/album/never-say-a-word/1234567890", "icon": "applemusic.svg" },
          { "name": "YouTube Music", "url": "https://music.youtube.com/playlist?list=PL1234567890", "icon": "youtubemusic.svg" },
          { "name": "Pandora", "url": "https://www.pandora.com/artist/tim-white/AR123456", "icon": "pandora.svg" },
          { "name": "Audius", "url": "https://audius.co/timwhite/never-say-a-word-123456", "icon": "audius.svg" },
          { "name": "iHeartRadio", "url": "https://www.iheart.com/artist/tim-white-123456", "icon": "iheartradio.svg" },
          { "name": "Amazon Music", "url": "https://music.amazon.com/albums/123456", "icon": "amazonmusic.svg" },
          { "name": "Soundcloud", "url": "https://soundcloud.com/timwhite/never-say-a-word", "icon": "soundcloud.svg" }
        ]
      }
    }
  }
}
```

### 2. Components and Pages

Ensure your `StreamingIcons.vue` component handles the icon imports correctly and dynamically.

**components/StreamingIcons.vue:**
```vue
<template>
  <div>
    <img :src="`/icons/${icon}`" :alt="alt" class="h-8 w-8"/>
  </div>
</template>

<script setup>
defineProps({
  icon: String,
  alt: String
});
</script>
```

### 3. Dynamic Song Page Component

Create a dynamic song page component under `pages/[creatorName]/[songSlug].vue`:

**pages/[creatorName]/[songSlug].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="songData.albumArt"
          :alt="songData.songTitle"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorName }}
        </h2>
      </div>

      <div class="text-center mx-auto mt-4" v-if="isFutureRelease">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Releases in: {{ countdown }}
        </h3>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ songData.songTitle }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ songData.description }}</p>
        </div>

        <!-- Options -->
        <div class="mt-10 text-center">
          <form class="mt-10">
            <div class="mt-10">
              <div class="flex items-center justify-center">
                <h3 class="text-sm font-medium text-gray-900">Listen on</h3>
              </div>
              <fieldset aria-label="Choose a music service" class="mt-4">
                <RadioGroup
                  v-model="selectedService"
                  class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3"
                >
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
                    v-if="service.url"
                    v-slot="{ active, checked }"
                  >
                    <div
                      :class="[
                        'cursor-pointer bg-white text-gray-900 shadow-sm',
                        active ? 'ring-2 ring-indigo-500' : '',
                        'group relative flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium uppercase hover:bg-gray-50 focus:outline-none',
                      ]"
                    >
                      <StreamingIcons :icon="service.icon" :alt="service.name"/>
                      <span
                        :class="[
                          active ? 'border' : 'border-2',
                          checked ? 'border-indigo-500' : 'border-transparent',
                          'pointer-events-none absolute -inset-px rounded-md',
                        ]"
                        aria-hidden="true"
                      />
                    </div>
                  </RadioGroupOption>
                </RadioGroup>
              </fieldset>
            </div>

            <a
              :href="selectedService.url"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </a>
          </form>
        </div>
      </div


Dont specify the icons in the json. Do it in the song page as they never change


To streamline the implementation and avoid specifying icons in the JSON, you can define the icon mapping within the song page component. Here’s how to update the setup:

### 1. JSON Data Structure

**creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "songs": {
      "nsaw": {
        "songTitle": "Never Say A Word",
        "albumArt": "/img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01T00:00:00Z",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3" },
          { "name": "Apple Music", "url": "https://music.apple.com/us/album/never-say-a-word/1234567890" },
          { "name": "YouTube Music", "url": "https://music.youtube.com/playlist?list=PL1234567890" },
          { "name": "Pandora", "url": "https://www.pandora.com/artist/tim-white/AR123456" },
          { "name": "Audius", "url": "https://audius.co/timwhite/never-say-a-word-123456" },
          { "name": "iHeartRadio", "url": "https://www.iheart.com/artist/tim-white-123456" },
          { "name": "Amazon Music", "url": "https://music.amazon.com/albums/123456" },
          { "name": "Soundcloud", "url": "https://soundcloud.com/timwhite/never-say-a-word" }
        ]
      }
    }
  }
}
```

### 2. Dynamic Song Page Component

Create a dynamic song page component under `pages/[creatorName]/[songSlug].vue`:

**pages/[creatorName]/[songSlug].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="songData.albumArt"
          :alt="songData.songTitle"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorName }}
        </h2>
      </div>

      <div class="text-center mx-auto mt-4" v-if="isFutureRelease">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Releases in: {{ countdown }}
        </h3>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ songData.songTitle }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ songData.description }}</p>
        </div>

        <!-- Options -->
        <div class="mt-10 text-center">
          <form class="mt-10">
            <div class="mt-10">
              <div class="flex items-center justify-center">
                <h3 class="text-sm font-medium text-gray-900">Listen on</h3>
              </div>
              <fieldset aria-label="Choose a music service" class="mt-4">
                <RadioGroup
                  v-model="selectedService"
                  class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3"
                >
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
                    v-if="service.url"
                    v-slot="{ active, checked }"
                  >
                    <div
                      :class="[
                        'cursor-pointer bg-white text-gray-900 shadow-sm',
                        active ? 'ring-2 ring-indigo-500' : '',
                        'group relative flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium uppercase hover:bg-gray-50 focus:outline-none',
                      ]"
                    >
                      <img
                        :src="getIconPath(service.name)"
                        :alt="service.name"
                        class="h-8 w-8"
                      />
                      <span
                        :class="[
                          active ? 'border' : 'border-2',
                          checked ? 'border-indigo-500' : 'border-transparent',
                          'pointer-events-none absolute -inset-px rounded-md',
                        ]"
                        aria-hidden="true"
                      />
                    </div>
                  </RadioGroupOption>
                </RadioGroup>
              </fieldset>
            </div>

            <a
              :href="selectedService.url"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </a>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const selectedService = ref({});
const creatorName = ref("");
const isFutureRelease = ref(false);
const countdown = ref('');

const iconMap = {
  "Spotify": "/icons/spotify.svg",
  "Apple Music": "/icons/applemusic.svg",
  "YouTube Music": "/icons/youtubemusic.svg",
  "Pandora": "/icons/pandora.svg",
  "Audius": "/icons/audius.svg",
  "iHeartRadio": "/icons/iheartradio.svg",
  "Amazon Music": "/icons/amazonmusic.svg",
  "Soundcloud": "/icons/soundcloud.svg"
};

const getIconPath = (serviceName) => {
  return iconMap[serviceName] || "";
};

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name;
  songData.value = creator.songs[route.params.songSlug] || {};
  selectedService.value = songData.value.services.find(service => service.url) || {};

  if (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorName.value} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });
});
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Summary

- **Icon Mapping:** Defined within the song page component.
- **Conditional Rendering:** Only render services with valid URLs.
- **Dynamic Metadata:** Using `useSeoMeta` for setting page title and description dynamically.

This setup ensures that icons are handled dynamically within the component, reducing redundancy and simplifying the JSON structure.



 WARN  [Vue Router warn]: uncaught error during route navigation:


 ERROR  [vite-node] [ERR_LOAD_URL] dayjs

  at dayjs


The issue you're encountering with importing `dayjs` can be resolved by ensuring `dayjs` is properly installed and imported in your project. Here’s how you can update the component:

### 1. Ensure `dayjs` is installed

First, make sure `dayjs` is installed in your project. If it’s not installed, you can install it via npm:

```bash
npm install dayjs
```

### 2. Update the Component

**pages/[creatorName]/[songSlug].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="songData.albumArt"
          :alt="songData.songTitle"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorName }}
        </h2>
      </div>

      <div class="text-center mx-auto mt-4" v-if="isFutureRelease">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Releases in: {{ countdown }}
        </h3>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ songData.songTitle }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ songData.description }}</p>
        </div>

        <!-- Options -->
        <div class="mt-10 text-center">
          <form class="mt-10">
            <div class="mt-10">
              <div class="flex items-center justify-center">
                <h3 class="text-sm font-medium text-gray-900">Listen on</h3>
              </div>
              <fieldset aria-label="Choose a music service" class="mt-4">
                <RadioGroup
                  v-model="selectedService"
                  class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3"
                >
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
                    v-if="service.url"
                    v-slot="{ active, checked }"
                  >
                    <div
                      :class="[
                        'cursor-pointer bg-white text-gray-900 shadow-sm',
                        active ? 'ring-2 ring-indigo-500' : '',
                        'group relative flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium uppercase hover:bg-gray-50 focus:outline-none',
                      ]"
                    >
                      <img
                        :src="getIconPath(service.name)"
                        :alt="service.name"
                        class="h-8 w-8"
                      />
                      <span
                        :class="[
                          active ? 'border' : 'border-2',
                          checked ? 'border-indigo-500' : 'border-transparent',
                          'pointer-events-none absolute -inset-px rounded-md',
                        ]"
                        aria-hidden="true"
                      />
                    </div>
                  </RadioGroupOption>
                </RadioGroup>
              </fieldset>
            </div>

            <a
              :href="selectedService.url"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </a>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const selectedService = ref({});
const creatorName = ref("");
const isFutureRelease = ref(false);
const countdown = ref('');

const iconMap = {
  "Spotify": "/icons/spotify.svg",
  "Apple Music": "/icons/applemusic.svg",
  "YouTube Music": "/icons/youtubemusic.svg",
  "Pandora": "/icons/pandora.svg",
  "Audius": "/icons/audius.svg",
  "iHeartRadio": "/icons/iheartradio.svg",
  "Amazon Music": "/icons/amazonmusic.svg",
  "Soundcloud": "/icons/soundcloud.svg"
};

const getIconPath = (serviceName) => {
  return iconMap[serviceName] || "";
};

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name;
  songData.value = creator.songs[route.params.songSlug] || {};
  selectedService.value = songData.value.services.find(service => service.url) || {};

  if (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorName.value} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });
});
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Key Changes:
1. **Import `dayjs` and `relativeTime` plugin** to handle date calculations.
2. **Updated onMounted hook** to handle the countdown logic and check if the release date is in the future.

This should resolve the issue with `dayjs` and properly handle the countdown for future releases.



500
Cannot read properties of undefined (reading 'url')

at renderFnWithContext (./node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:825:13)
at normalizeChildren (./node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:7320:34)
at createBaseVNode (./node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:7128:5)
at _createVNode (./node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:7205:10)
at Object.createVNodeWithArgsTransform [as createVNode] (./node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:7083:10)
at Module.ssrRenderComponent (./node_modules/@vue/server-renderer/dist/server-renderer.cjs.js:85:9)
at _sfc_ssrRender (./pages/[creatorName]/[songSlug].js:131:31)
at renderComponentSubTree (./node_modules/@vue/server-renderer/dist/server-renderer.cjs.js:695:9)
at renderComponentVNode (./node_modules/@vue/server-renderer/dist/server-renderer.cjs.js:641:12)

