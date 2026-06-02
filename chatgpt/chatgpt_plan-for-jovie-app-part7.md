
To achieve the desired setup, we need to create a JSON file to store the song details and then fetch and use that data in the `nsaw.vue` component. Here’s how to do it step by step:

1. **Create the JSON file**: Store the song details in a JSON file, e.g., `songs.json`.

2. **Fetch the data in the component**: Update the `nsaw.vue` component to fetch and use this data.

### Step 1: Create `songs.json`

Create a file `public/songs.json` and add the song details:

```json
{
  "neverSayAWord": {
    "artist": "Tim White",
    "songTitle": "Never Say A Word",
    "albumArt": "/img/album_art/never-say-a-word.jpg",
    "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
    "services": [
      { "name": "Spotify", "icon": "spotify.svg" },
      { "name": "Apple Music", "icon": "applemusic.svg" },
      { "name": "YouTube Music", "icon": "youtubemusic.svg" },
      { "name": "Pandora", "icon": "pandora.svg" },
      { "name": "Audius", "icon": "audius.svg" },
      { "name": "iHeartRadio", "icon": "iheartradio.svg" },
      { "name": "Amazon Music", "icon": "amazonmusic.svg" },
      { "name": "Soundcloud", "icon": "soundcloud.svg" }
    ]
  }
}
```

### Step 2: Update `nsaw.vue`

Modify your `nsaw.vue` component to fetch data from the JSON file and use it.

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
          {{ songData.artist }}
        </h2>
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

            <button
              type="submit"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const songData = ref({});
const selectedService = ref({});

onMounted(async () => {
  const response = await fetch('/songs.json');
  const data = await response.json();
  songData.value = data['neverSayAWord'];
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useSeoMeta({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
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

### Explanation
- The `onMounted` hook fetches data from `songs.json` when the component is mounted.
- The `useSeoMeta` function from `nuxt-seo-kit` sets the page title and description dynamically based on the song data.
- The song details are displayed using the fetched data, ensuring the content is dynamically updated.


{
    "neverSayAWord": {
      "artist": "Tim White",
      "songTitle": "Never Say A Word",
      "albumArt": "img/album_art/never-say-a-word.jpg",
      "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
      "services": [
        { "name": "Spotify", url:"https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3" "icon": "spotify.svg" },
        { "name": "Apple Music", "icon": "applemusic.svg" },
        { "name": "YouTube Music", "icon": "youtubemusic.svg" },
        { "name": "Pandora", "icon": "pandora.svg" },
        { "name": "Audius", "icon": "audius.svg" },
        { "name": "iHeartRadio", "icon": "iheartradio.svg" },
        { "name": "Amazon Music", "icon": "amazonmusic.svg" },
        { "name": "Soundcloud", "icon": "soundcloud.svg" }
      ]
    }
  }


To incorporate the song data from a JSON file and ensure the song's metadata is dynamically set, we need to fetch the data and utilize it appropriately within the component. Here's how you can achieve this:

### Step 1: Create `songs.json`

Ensure your `songs.json` file in the `public` directory is properly formatted:

```json
{
  "neverSayAWord": {
    "artist": "Tim White",
    "songTitle": "Never Say A Word",
    "albumArt": "img/album_art/never-say-a-word.jpg",
    "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
    "services": [
      { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
      { "name": "Apple Music", "icon": "applemusic.svg", "url": "#" },
      { "name": "YouTube Music", "icon": "youtubemusic.svg", "url": "#" },
      { "name": "Pandora", "icon": "pandora.svg", "url": "#" },
      { "name": "Audius", "icon": "audius.svg", "url": "#" },
      { "name": "iHeartRadio", "icon": "iheartradio.svg", "url": "#" },
      { "name": "Amazon Music", "icon": "amazonmusic.svg", "url": "#" },
      { "name": "Soundcloud", "icon": "soundcloud.svg", "url": "#" }
    ]
  }
}
```

### Step 2: Update `nsaw.vue`

Modify your `nsaw.vue` component to fetch and use the song data:

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
          {{ songData.artist }}
        </h2>
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
                <RadioGroup v-model="selectedService" class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-3">
                  <RadioGroupOption
                    as="template"
                    v-for="service in songData.services"
                    :key="service.name"
                    :value="service"
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

            <button
              type="submit"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const songData = ref({});
const selectedService = ref({});

onMounted(async () => {
  const response = await fetch('/songs.json');
  const data = await response.json();
  songData.value = data['neverSayAWord'];
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useSeoMeta({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
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

### Explanation

- **Fetching Data**: The `onMounted` hook fetches the song data from `songs.json` and assigns it to `songData`.
- **Dynamic Content**: The component dynamically updates to show the song's title, artist, album art, and links based on the JSON data.
- **SEO Meta**: The `useSeoMeta` function from `nuxt-seo-kit` sets the page title and description based on the song data. This ensures that the meta tags are updated dynamically for each song.
- **Form Handling**: The `v-model` on `RadioGroup` binds the selected service, allowing users to choose a music service.

This setup makes it easy to update the song details by modifying the JSON file without changing the component code.


Modify this to pull in the url of each service link

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
          {{ songData.artist }}
        </h2>
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

            <button
              type="submit"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const songData = ref({});
const selectedService = ref({});

onMounted(async () => {
  const response = await fetch("/songs.json");
  const data = await response.json();
  songData.value = data["neverSayAWord"];
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useSeoMeta({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
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



To incorporate the URL of each service link, we need to modify the button to navigate to the selected service's URL. Here is the updated code:

### Step 1: Update `songs.json`

Ensure your `songs.json` file includes the URLs for each service:

```json
{
  "neverSayAWord": {
    "artist": "Tim White",
    "songTitle": "Never Say A Word",
    "albumArt": "img/album_art/never-say-a-word.jpg",
    "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
    "services": [
      { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
      { "name": "Apple Music", "url": "#", "icon": "applemusic.svg" },
      { "name": "YouTube Music", "url": "#", "icon": "youtubemusic.svg" },
      { "name": "Pandora", "url": "#", "icon": "pandora.svg" },
      { "name": "Audius", "url": "#", "icon": "audius.svg" },
      { "name": "iHeartRadio", "url": "#", "icon": "iheartradio.svg" },
      { "name": "Amazon Music", "url": "#", "icon": "amazonmusic.svg" },
      { "name": "Soundcloud", "url": "#", "icon": "soundcloud.svg" }
    ]
  }
}
```

### Step 2: Update `nsaw.vue`

Modify your `nsaw.vue` component to use the URLs:

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
          {{ songData.artist }}
        </h2>
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

            <button
              type="button"
              @click="openLink"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const songData = ref({});
const selectedService = ref({});

const openLink = () => {
  if (selectedService.value.url) {
    window.open(selectedService.value.url, "_blank");
  }
};

onMounted(async () => {
  const response = await fetch("/songs.json");
  const data = await response.json();
  songData.value = data["neverSayAWord"];
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useSeoMeta({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
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

### Explanation

1. **Data Structure**: The `songs.json` file includes URLs for each service.
2. **Dynamic URL**: The `openLink` method opens the URL of the selected service in a new tab when the "Listen now" button is clicked.
3. **Script Setup**: The script setup fetches the song data and initializes the `selectedService` with the first service in the list.

This setup allows for easy updating of song details and service URLs directly from the JSON file, ensuring that the component dynamically reflects the updated information.


Add a release date. If the realize date is in the future show a countdown above the  song title

If no url we should not display that service. 


Here is the updated code with the release date and countdown functionality. The countdown will be displayed above the song title if the release date is in the future. Additionally, services without a URL will not be displayed.

### Updated `songs.json`
Ensure your `songs.json` includes the release date and URLs:

```json
{
  "neverSayAWord": {
    "artist": "Tim White",
    "songTitle": "Never Say A Word",
    "albumArt": "img/album_art/never-say-a-word.jpg",
    "releaseDate": "2024-07-01T00:00:00Z",
    "description": "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
    "services": [
      { "name": "Spotify", "url": "https://open.spotify.com/track/4q3AmpMI83wv5zHJYyXQsH?si=0d7e0e615a5b464f&nd=1&dlsi=95cba8ab82d246b3", "icon": "spotify.svg" },
      { "name": "Apple Music", "url": "#", "icon": "applemusic.svg" },
      { "name": "YouTube Music", "url": "#", "icon": "youtubemusic.svg" },
      { "name": "Pandora", "icon": "pandora.svg" },
      { "name": "Audius", "url": "#", "icon": "audius.svg" },
      { "name": "iHeartRadio", "icon": "iheartradio.svg" },
      { "name": "Amazon Music", "url": "#", "icon": "amazonmusic.svg" },
      { "name": "Soundcloud", "icon": "soundcloud.svg" }
    ]
  }
}
```

### Updated `nsaw.vue`
Here is the updated component:

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
          {{ songData.artist }}
        </h2>
      </div>

      <!-- Countdown -->
      <div v-if="timeRemaining" class="text-center mx-auto mt-4">
        <h3 class="text-lg font-medium text-gray-900">
          Releases in {{ timeRemaining.days }}d {{ timeRemaining.hours }}h {{ timeRemaining.minutes }}m {{ timeRemaining.seconds }}s
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
                    v-for="service in filteredServices"
                    :key="service.name"
                    :value="service"
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

            <button
              type="button"
              @click="openLink"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";
import { useIntervalFn } from '@vueuse/core';
import { useSeoMeta } from '#app';

const songData = ref({});
const selectedService = ref({});
const timeRemaining = ref(null);

const calculateTimeRemaining = (releaseDate) => {
  const now = new Date().getTime();
  const distance = new Date(releaseDate).getTime() - now;

  if (distance < 0) {
    timeRemaining.value = null;
    return;
  }

  timeRemaining.value = {
    days: Math.floor(distance / (1000 * 60 * 60 * 24)),
    hours: Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((distance % (1000 * 60)) / 1000)
  };
};

const openLink = () => {
  if (selectedService.value.url) {
    window.open(selectedService.value.url, "_blank");
  }
};

onMounted(async () => {
  const response = await fetch("/songs.json");
  const data = await response.json();
  songData.value = data["neverSayAWord"];
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useSeoMeta({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });

  // Calculate initial time remaining
  calculateTimeRemaining(songData.value.releaseDate);

  // Update countdown every second
  useIntervalFn(() => calculateTimeRemaining(songData.value.releaseDate), 1000);
});

const filteredServices = computed(() => {
  return songData.value.services.filter(service => service.url);
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

### Explanation
1. **Countdown Calculation**: The `calculateTimeRemaining` function calculates the time remaining until the release date and updates the `timeRemaining` ref.
2. **Filtered Services**: The `filteredServices` computed property filters out services without a URL.
3. **Conditional Countdown Display**: The countdown is displayed only if the `timeRemaining` ref is not null.
4. **Open Link**: The `openLink` function opens the URL of the selected service when the "Listen now" button is clicked.
5. **Dynamic Meta Tags**: The `useSeoMeta` function sets the page title and description dynamically based on the song data.


{'asset_pointer': 'file-service://file-0dz6HTMWfHxQR6cJLdASOMb1', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 545, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 78626, 'width': 858}
F


The warning `No match found for location with path "/tim/undefined"` indicates that there's an issue with the URL or routing in the application. Let's review and correct the routing and how the song data is being referenced.

To make sure the URL paths are correct, let's add more clarity to how the song data is fetched and used. Ensure the `path` and `name` in your router configuration match the component and URL you are trying to access.

Here's an improved approach to handle routing and dynamic data fetching:

1. **Router Configuration**: Ensure the `path` in your router configuration matches the component and URL.

```javascript
// router/index.js or your routes configuration file
export default [
  {
    path: '/tim/nsaw',  // ensure this matches the path you're trying to access
    name: 'nsaw',
    component: () => import('@/pages/tim/nsaw.vue'),
  },
  // other routes
];
```

2. **Page Component**: Ensure the `nsaw.vue` component fetches data correctly and handles undefined data scenarios.

### `nsaw.vue`
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
          {{ songData.artist }}
        </h2>
      </div>

      <!-- Countdown -->
      <div v-if="timeRemaining" class="text-center mx-auto mt-4">
        <h3 class="text-lg font-medium text-gray-900">
          Releases in {{ timeRemaining.days }}d {{ timeRemaining.hours }}h {{ timeRemaining.minutes }}m {{ timeRemaining.seconds }}s
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
                    v-for="service in filteredServices"
                    :key="service.name"
                    :value="service"
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

            <button
              type="button"
              @click="openLink"
              class="mt-10 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Listen now
            </button>
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";
import { useIntervalFn } from '@vueuse/core';
import { useSeoMeta } from '#app';

const songData = ref({});
const selectedService = ref({});
const timeRemaining = ref(null);

const calculateTimeRemaining = (releaseDate) => {
  const now = new Date().getTime();
  const distance = new Date(releaseDate).getTime() - now;

  if (distance < 0) {
    timeRemaining.value = null;
    return;
  }

  timeRemaining.value = {
    days: Math.floor(distance / (1000 * 60 * 60 * 24)),
    hours: Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((distance % (1000 * 60)) / 1000)
  };
};

const openLink = () => {
  if (selectedService.value.url) {
    window.open(selectedService.value.url, "_blank");
  }
};

onMounted(async () => {
  const response = await fetch("/songs.json");
  const data = await response.json();
  songData.value = data["neverSayAWord"] || {};
  if (!songData.value.songTitle) {
    console.error("Song data is undefined");
  } else {
    selectedService.value = songData.value.services.find(service => service.url) || {};

    // Set page title and description
    useSeoMeta({
      title: `${songData.value.artist} - ${songData.value.songTitle}`,
      description: songData.value.description,
    });

    // Calculate initial time remaining
    calculateTimeRemaining(songData.value.releaseDate);

    // Update countdown every second
    useIntervalFn(() => calculateTimeRemaining(songData.value.releaseDate), 1000);
  }
});

const filteredServices = computed(() => {
  return songData.value.services.filter(service => service.url);
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

### Explanation
1. **Router Configuration**: Ensure the path matches the intended route.
2. **Fetching and Handling Data**: In `nsaw.vue`, we fetch data from `songs.json`, check if the data exists, and handle it properly.
3. **Filtered Services**: We filter out services without a URL using the `filteredServices` computed property.
4. **Conditional Countdown Display**: The countdown is displayed only if `timeRemaining` is not null.
5. **Error Handling**: Added a console error if `songData` is undefined. 

Ensure the `songs.json` file is correctly formatted and includes all required fields. This setup ensures the dynamic data is fetched and handled correctly, avoiding issues with undefined paths.


Ok now we need to set up our site to dynamically  create linkinbio profiles for each user. So user Tim will be jov.ie/tim and Kenzie with be jov.ie/kenzie.  The profile page will show their name dynamically. For now we will pull the users from a json file. 

Now we might want to call this profiles artists or creators or something. Because we will have in the future users who just manage profiles but aren't the actual person. So we want to distinguish actual users of the app from users with public profiles. So maybe we use the term creators. So lets do creator profiles with dynamic routes based on user name pulllng from json for now


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_jovie-analysis-and-plan-part1]]
- [[chatgpt/chatgpt_jovie-analysis-and-plan-part2]]
- [[chatgpt/chatgpt_jovie-link-in-bio-plan-part1]]
- [[chatgpt/chatgpt_jovie-link-in-bio-plan-part2]]
- [[chatgpt/chatgpt_jovie-link-in-bio-plan-part3]]
