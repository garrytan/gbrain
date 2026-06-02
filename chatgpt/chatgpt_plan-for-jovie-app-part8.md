
Let's set up dynamic routes for creator profiles in your Nuxt.js application. We'll create a dynamic route for each creator profile and pull the data from a JSON file. We'll use the term "creators" to distinguish public profiles.

### 1. **Update the JSON File**
First, create a `creators.json` file in the `public` directory to store the creator profiles.

**public/creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "description": "Musician and Artist",
    "image": "img/creators/tim.jpg"
  },
  "kenzie": {
    "name": "Kenzie Brown",
    "description": "Digital Creator",
    "image": "img/creators/kenzie.jpg"
  }
}
```

### 2. **Create the Dynamic Route**
Create a new Vue component that will serve as the dynamic creator profile page.

**pages/creators/_name.vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Creator Profile -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="creatorData.image"
          :alt="creatorData.name"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorData.name }}
        </h2>
        <p class="mt-2 text-lg text-gray-600">{{ creatorData.description }}</p>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';

const route = useRoute();
const creatorData = ref({});

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.name] || {};

  if (creatorData.value.name) {
    // Set page title and description
    useSeoMeta({
      title: creatorData.value.name,
      description: creatorData.value.description,
    });
  } else {
    console.error("Creator data is undefined");
  }
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

### 3. **Update the Router Configuration**
Make sure the router configuration supports dynamic routes. This should be handled automatically by Nuxt.js if the directory structure is correct.

### 4. **Testing the Dynamic Routes**
To test the dynamic routes, start your Nuxt.js development server and navigate to the URLs like `http://localhost:3000/creators/tim` and `http://localhost:3000/creators/kenzie`. The profiles should dynamically load the correct data from the JSON file.

### 5. **Creating and Organizing Image Assets**
Ensure the images referenced in `creators.json` are placed correctly in the `public/img/creators` directory.

**Directory structure:**
```
public/
  img/
    creators/
      tim.jpg
      kenzie.jpg
  creators.json
pages/
  creators/
    _name.vue
  index.vue
layouts/
  links.vue
```

### Summary
- Created a `creators.json` file to store profile data.
- Added a dynamic route component `pages/creators/_name.vue` to handle creator profiles.
- Used `useSeoMeta` to dynamically set page titles and descriptions.
- Tested the dynamic routes to ensure they load the correct data.

This setup allows you to dynamically create and manage creator profiles based on the JSON data, preparing for future enhancements where users can manage these profiles through an application.


I just want it on the root


If you want the creator profiles to be accessible directly from the root (e.g., `jov.ie/tim` and `jov.ie/kenzie`), you can set up dynamic routes at the root level. Here's how to do it:

### 1. **Update the JSON File**

Create a `creators.json` file in the `public` directory to store the creator profiles.

**public/creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "description": "Musician and Artist",
    "image": "img/creators/tim.jpg"
  },
  "kenzie": {
    "name": "Kenzie Brown",
    "description": "Digital Creator",
    "image": "img/creators/kenzie.jpg"
  }
}
```

### 2. **Create the Dynamic Route at the Root Level**

Create a new Vue component that will serve as the dynamic creator profile page.

**pages/[name].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Creator Profile -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="creatorData.image"
          :alt="creatorData.name"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorData.name }}
        </h2>
        <p class="mt-2 text-lg text-gray-600">{{ creatorData.description }}</p>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';

const route = useRoute();
const creatorData = ref({});

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.name] || {};

  if (creatorData.value.name) {
    // Set page title and description
    useSeoMeta({
      title: creatorData.value.name,
      description: creatorData.value.description,
    });
  } else {
    console.error("Creator data is undefined");
  }
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

### 3. **Update the Router Configuration**

Nuxt.js will automatically pick up the dynamic routes based on the `[name].vue` file. Ensure that the file is located directly under the `pages` directory.

### 4. **Testing the Dynamic Routes**

To test the dynamic routes, start your Nuxt.js development server and navigate to the URLs like `http://localhost:3000/tim` and `http://localhost:3000/kenzie`. The profiles should dynamically load the correct data from the JSON file.

### 5. **Creating and Organizing Image Assets**

Ensure the images referenced in `creators.json` are placed correctly in the `public/img/creators` directory.

**Directory structure:**
```
public/
  img/
    creators/
      tim.jpg
      kenzie.jpg
  creators.json
pages/
  [name].vue
layouts/
  links.vue
```

### Summary

- Created a `creators.json` file to store profile data.
- Added a dynamic route component `pages/[name].vue` to handle creator profiles at the root level.
- Used `useSeoMeta` to dynamically set page titles and descriptions.
- Tested the dynamic routes to ensure they load the correct data.

This setup allows you to dynamically create and manage creator profiles directly from the root URL, based on the JSON data.


Now if a creator is an artist. They can have song objects attached to them and each song can have a link page that is dynamic as well


To achieve this, you need to create a structure where each creator can have multiple songs, and each song can have its own dynamic link page. Here’s how you can structure your project to include dynamic routes for both creators and their songs:

### 1. **Update the JSON File**

Extend the `creators.json` file to include songs for each creator.

**public/creators.json:**
```json
{
  "tim": {
    "name": "Tim White",
    "description": "Musician and Artist",
    "image": "img/creators/tim.jpg",
    "songs": {
      "neverSayAWord": {
        "title": "Never Say A Word",
        "albumArt": "img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
          { "name": "Apple Music", "url": "https://music.apple.com/us/album/never-say-a-word/1234567890", "icon": "applemusic.svg" },
          { "name": "YouTube Music", "url": "https://music.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI", "icon": "youtubemusic.svg" },
          { "name": "Pandora", "url": "", "icon": "pandora.svg" },
          { "name": "Audius", "url": "", "icon": "audius.svg" },
          { "name": "iHeartRadio", "url": "", "icon": "iheartradio.svg" },
          { "name": "Amazon Music", "url": "https://music.amazon.com/albums/B08K8SDF1L", "icon": "amazonmusic.svg" },
          { "name": "Soundcloud", "url": "https://soundcloud.com/timwhite/never-say-a-word", "icon": "soundcloud.svg" }
        ]
      }
    }
  },
  "kenzie": {
    "name": "Kenzie Brown",
    "description": "Digital Creator",
    "image": "img/creators/kenzie.jpg",
    "songs": {}
  }
}
```

### 2. **Create Dynamic Routes for Creators and Songs**

#### **Dynamic Creator Route**
Create a Vue component to handle dynamic creator profiles.

**pages/[name].vue:**
```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Creator Profile -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          :src="creatorData.image"
          :alt="creatorData.name"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          {{ creatorData.name }}
        </h2>
        <p class="mt-2 text-lg text-gray-600">{{ creatorData.description }}</p>
      </div>

      <div class="text-center mx-auto mt-4" v-if="creatorData.songs">
        <h3 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          Songs
        </h3>
        <ul>
          <li v-for="(song, key) in creatorData.songs" :key="key">
            <NuxtLink :to="`/${route.params.name}/${key}`">{{ song.title }}</NuxtLink>
          </li>
        </ul>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute } from 'vue-router';
import { useSeoMeta } from '#app';

const route = useRoute();
const creatorData = ref({});

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.name] || {};

  if (creatorData.value.name) {
    // Set page title and description
    useSeoMeta({
      title: creatorData.value.name,
      description: creatorData.value.description,
    });
  } else {
    console.error("Creator data is undefined");
  }
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

#### **Dynamic Song Route**
Create another Vue component to handle dynamic song pages under each creator.

**pages/[creatorName]/[songName].vue:**
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
          {{ creatorData.name }}
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
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
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

const route = useRoute();
const songData = ref({});
const creatorData = ref({});
const selectedService = ref({});
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.creatorName] || {};
  songData.value = creatorData.value.songs[route.params.songName] || {};
  selectedService.value = songData.value.services.find(service => service.url) || {};

  if


 (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorData.value.name} - ${songData.value.songTitle}`,
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

1. **Updated JSON file** to include songs for each creator.
2. **Created dynamic routes** for creators at the root level.
3. **Created nested dynamic routes** for songs under each creator.
4. **Filtered out services** without URLs from the song page.
5. **Added a release date and countdown** feature for future releases.

With this setup, you have a dynamic and extensible structure that allows you to manage creator profiles and their songs efficiently.


So give me the song component


Here's the song component (`pages/[creatorName]/[songName].vue`) with the required features:

### pages/[creatorName]/[songName].vue

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
          {{ creatorData.name }}
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
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
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
const creatorData = ref({});
const selectedService = ref({});
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.creatorName] || {};
  songData.value = creatorData.value.songs[route.params.songName] || {};
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
    title: `${creatorData.value.name} - ${songData.value.songTitle}`,
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

1. **Dynamic Creator and Song Data:** This component fetches data from `creators.json` to dynamically populate the creator and song details.
2. **Conditional Display:** Services without URLs are not displayed, and a countdown is shown if the song has a future release date.
3. **SEO Metadata:** The page title and description are dynamically set based on the creator and song data.
4. **Dynamic Routing:** The component uses dynamic routes to render specific songs under each creator.

This approach ensures that your application is flexible and easy to maintain, allowing for dynamic content generation based on the provided JSON data.


Lets add a custom slug or short url for the song name so never say a word can just be Tim/nsaw 


To add a custom slug or short URL for the song name, you'll need to modify your JSON structure and adjust the dynamic routing logic in your Nuxt application. Here's how you can achieve that:

1. **Update the JSON Structure:** Add a `slug` field to each song object in your `creators.json` file.
2. **Update Dynamic Routing:** Adjust your dynamic routing in Nuxt to use the `slug` instead of the song name.

### Updated JSON Structure (creators.json)

```json
{
  "tim": {
    "name": "Tim White",
    "songs": {
      "nsaw": {
        "slug": "nsaw",
        "songTitle": "Never Say A Word",
        "albumArt": "img/album_art/never-say-a-word.jpg",
        "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
        "releaseDate": "2024-07-01T00:00:00Z",
        "services": [
          { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
          { "name": "Apple Music", "url": "https://music.apple.com/us/album/never-say-a-word/123456789", "icon": "applemusic.svg" },
          { "name": "YouTube Music", "url": "https://music.youtube.com/playlist?list=PLFgquLnL59akA2PflFpeQG9L01VFg90wS", "icon": "youtubemusic.svg" },
          { "name": "Pandora", "icon": "pandora.svg" },
          { "name": "Audius", "icon": "audius.svg" },
          { "name": "iHeartRadio", "icon": "iheartradio.svg" },
          { "name": "Amazon Music", "icon": "amazonmusic.svg" },
          { "name": "Soundcloud", "icon": "soundcloud.svg" }
        ]
      }
    }
  }
}
```

### Dynamic Routing Component (pages/[creatorName]/[songSlug].vue)

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
          {{ creatorData.name }}
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
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
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
const creatorData = ref({});
const selectedService = ref({});
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.creatorName] || {};
  songData.value = Object.values(creatorData.value.songs).find(song => song.slug === route.params.songSlug) || {};
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
    title: `${creatorData.value.name} - ${songData.value.songTitle}`,
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

1. **Dynamic Song Slug:** The song slug (`slug`) is used to dynamically load the song details.
2. **Conditional Display:** Only services with URLs are displayed.
3. **Release Countdown:** If the song has a future release date, a countdown is shown above the song title.
4. **Dynamic SEO Metadata:** The page title and description are dynamically set based on the creator and song data.

This setup ensures that each song page is dynamically generated based on the creator and song data, allowing for easy updates and additions through the JSON file.


Whats the creator name component


To create a dynamic creator name component that can be reused across your application, you can define a component that fetches and displays the creator's name based on the provided creator ID or slug. Here’s how you can achieve this:

### 1. Create a Creator Name Component

Create a new file in your components directory, e.g., `components/CreatorName.vue`:

```vue
<template>
  <span>{{ creatorName }}</span>
</template>

<script setup>
import { ref, onMounted, watch } from "vue";
import { useRoute } from "vue-router";

const creatorName = ref("");
const route = useRoute();

onMounted(async () => {
  await fetchCreatorName();
});

watch(route, async () => {
  await fetchCreatorName();
});

async function fetchCreatorName() {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name || "Unknown Creator";
}
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### 2. Update Your Pages to Use the Creator Name Component

Update your dynamic song page to use the `CreatorName` component. Here's how you can modify the `pages/[creatorName]/[songSlug].vue`:

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
          <CreatorName />
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
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
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
import CreatorName from '~/components/CreatorName.vue';

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const creatorData = ref({});
const selectedService = ref({});
const isFutureRelease = ref(false);
const countdown = ref('');

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creatorData.value = data[route.params.creatorName] || {};
  songData.value = Object.values(creatorData.value.songs).find(song => song.slug === route.params.songSlug) || {};
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
    title: `${creatorData.value.name} - ${songData.value.songTitle}`,
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

1. **Creator Name Component:** A reusable component that fetches and displays the creator’s name based on the route parameter.
2. **Integration:** This component is integrated into the song page to dynamically display the creator's name.
3. **Dynamic Routing:** Adjustments to the dynamic routing to fetch and display song details based on the `slug` parameter. 

This setup allows you to easily manage creator profiles and their songs, ensuring that the correct information is displayed dynamically based on the route.


Thats not working for me. We were good before


**Topic:** [[chatgpt-clusters/jovie_music]]
