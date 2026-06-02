
To fix the centering of the album art and clean up the code by removing unused parameters and renaming things appropriately, here is the updated version of your code:

```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="text-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          src="img/album_art/never-say-a-word.jpg"
          alt="Never Say A Word"
        ></NuxtPicture>
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl mt-2">
          TIM WHITE
        </h2>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ product.name }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ product.description }}</p>
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
                    v-for="service in product.services"
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
import { ref } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const product = {
  name: "Never Say A Word",
  services: [
    { name: "Spotify", icon: "spotify.svg" },
    { name: "Apple Music", icon: "applemusic.svg" },
    { name: "YouTube Music", icon: "youtubemusic.svg" },
    { name: "Pandora", icon: "pandora.svg" },
    { name: "Audius", icon: "audius.svg" },
    { name: "iHeartRadio", icon: "iheartradio.svg" },
    { name: "Amazon Music", icon: "amazonmusic.svg" },
    { name: "Soundcloud", icon: "soundcloud.svg" },
  ],
  description:
    "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
};
const selectedService = ref(product.services[0]);
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Key Adjustments Made:
1. **Removed Unused Parameters:** The `href` and `inStock` properties were removed since they are not needed.
2. **Centered Album Art:** Adjusted the `class` for the album art container to ensure it's centered properly on the page.
3. **Cleaned Up Layout:** Ensured all elements are centered and properly aligned.
4. **Renamed Variables:** Ensured variable names are logical and relevant to their content.

These changes should center the album art and improve the overall layout and readability of the page.


Set it to use the links.vue layout also the album art is still not centered on the apge


To set the page to use the `links.vue` layout and ensure that the album art is centered on the page, follow these steps:

1. **Set the layout to `links.vue`.**
2. **Ensure the album art is properly centered.**

Here's the updated code:

### `tim/nsaw.vue`

```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          src="img/album_art/never-say-a-word.jpg"
          alt="Never Say A Word"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          TIM WHITE
        </h2>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            {{ product.name }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ product.description }}</p>
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
                    v-for="service in product.services"
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
import { ref } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const product = {
  name: "Never Say A Word",
  services: [
    { name: "Spotify", icon: "spotify.svg" },
    { name: "Apple Music", icon: "applemusic.svg" },
    { name: "YouTube Music", icon: "youtubemusic.svg" },
    { name: "Pandora", icon: "pandora.svg" },
    { name: "Audius", icon: "audius.svg" },
    { name: "iHeartRadio", icon: "iheartradio.svg" },
    { name: "Amazon Music", icon: "amazonmusic.svg" },
    { name: "Soundcloud", icon: "soundcloud.svg" },
  ],
  description:
    "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
};
const selectedService = ref(product.services[0]);
</script>

<script>
export default {
  layout: 'links',
}
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **Set the layout to `links.vue`**: This is done by adding the `layout` property to the `export default` block.
2. **Center the Album Art**: The `flex` and `justify-center` classes are added to the div containing `NuxtPicture` to ensure it is centered.

This setup should ensure that the album art is centered and the layout is correctly set to use `links.vue`.


Perfect. Now pull the artist name, song title, links, and album art from json. Reference the json so we can easily update the page in one place with different songs. The nuxt set should also be setup to include the artist name and song name in the page title and description meta tages


To achieve this, we will follow these steps:

1. **Create a JSON file** that holds the artist name, song title, links, and album art information.
2. **Fetch and use this JSON data** in the `tim/nsaw.vue` page.
3. **Set up Nuxt to include the artist name and song title in the page title and description meta tags**.

### Step 1: Create a JSON File

Create a JSON file named `songs.json` in the `static` directory (you can choose any directory, but `static` is a good place for static files).

#### `static/songs.json`
```json
{
  "neverSayAWord": {
    "artist": "Tim White",
    "songTitle": "Never Say A Word",
    "albumArt": "img/album_art/never-say-a-word.jpg",
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

### Step 2: Fetch and Use JSON Data in the Page

Update the `tim/nsaw.vue` file to fetch and use the JSON data.

#### `tim/nsaw.vue`
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
import { useHead } from "@vueuse/head";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const songData = ref(null);
const selectedService = ref(null);

onMounted(async () => {
  const response = await fetch('/songs.json');
  const data = await response.json();
  songData.value = data.neverSayAWord;
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useHead({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
    meta: [
      { name: 'description', content: songData.value.description },
    ],
  });
});
</script>

<script>
export default {
  layout: 'links',
}
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Step 3: Ensure `links.vue` Layout is Correctly Set Up

Ensure your `links.vue` layout is properly set up to handle the song and artist pages.

### Explanation:

1. **Fetching JSON Data**: The `onMounted` lifecycle hook fetches the song data from `songs.json` and assigns it to `songData`.
2. **Setting up Head Meta Tags**: Using `@vueuse/head`, the page title and description are set dynamically based on the fetched data.
3. **Binding Data**: The template binds the album art, artist name, song title, and services to the values from `songData`.

With these changes, the song data is dynamically fetched from a JSON file, making it easy to update the information in one place, and the page title and description are set dynamically.


<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          src="img/album_art/never-say-a-word.jpg"
          alt="Never Say A Word"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          TIM WHITE
        </h2>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
            {{ product.name }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ product.description }}</p>
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
                    v-for="service in product.services"
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
import { ref } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

const product = {
  name: "Never Say A Word",
  services: [
    { name: "Spotify", icon: "spotify.svg" },
    { name: "Apple Music", icon: "applemusic.svg" },
    { name: "YouTube Music", icon: "youtubemusic.svg" },
    { name: "Pandora", icon: "pandora.svg" },
    { name: "Audius", icon: "audius.svg" },
    { name: "iHeartRadio", icon: "iheartradio.svg" },
    { name: "Amazon Music", icon: "amazonmusic.svg" },
    { name: "Soundcloud", icon: "soundcloud.svg" },
  ],
  description:
    "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
};
const selectedService = ref(product.services[0]);
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>


Change this to reference the song title and album art from json in the script tag


To make the `tim/nsaw.vue` page dynamically pull data from a JSON file, you can update the script to fetch the data on mounted. Here’s how you can do it:

### Step 1: JSON File

Ensure you have your JSON file (`songs.json`) in the `static` directory:

#### `static/songs.json`
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

### Step 2: Update `tim/nsaw.vue`

Update your component to fetch the data from the JSON file and use it.

#### `tim/nsaw.vue`
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
import { useHead } from "@vueuse/head";

const songData = ref({});
const selectedService = ref({});

onMounted(async () => {
  const response = await fetch("/songs.json");
  const data = await response.json();
  songData.value = data.neverSayAWord;
  selectedService.value = songData.value.services[0];

  // Set page title and description
  useHead({
    title: `${songData.value.artist} - ${songData.value.songTitle}`,
    meta: [
      { name: "description", content: songData.value.description },
    ],
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

### Explanation:

1. **Fetching JSON Data**: The `onMounted` lifecycle hook fetches the song data from `songs.json` and assigns it to `songData`.
2. **Setting up Head Meta Tags**: Using `@vueuse/head`, the page title and description are set dynamically based on the fetched data.
3. **Binding Data**: The template binds the album art, artist name, song title, and services to the values from `songData`.

This setup will allow you to easily update the song information in the `songs.json` file without needing to change the `tim/nsaw.vue` component.


{'asset_pointer': 'file-service://file-xkeH0TOJtt6vvJVfsKXDjqcI', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 987, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 398727, 'width': 1536}


It appears that you encountered an issue with the `useHead` import. This is likely because `@vueuse/head` is not installed. To resolve this, we will:

1. Install `@vueuse/head`.
2. Update your component to fetch data from the JSON file.

### Step 1: Install `@vueuse/head`
Run the following command in your terminal:
```sh
npm install @vueuse/head
```

### Step 2: Update `tim/nsaw.vue`
Update your `tim/nsaw.vue` file to fetch the song data from `songs.json` and use the installed `useHead` from `@vueuse/head`.

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
                    v-slot="{ active, checked


I want nuxtseo not head


Sure, let's use `nuxt-seo-kit` to manage the page title and meta descriptions. Follow these steps:

### Step 1: Install `nuxt-seo-kit`
Run the following command to install `nuxt-seo-kit`:
```sh
npm install nuxt-seo-kit
```

### Step 2: Configure `nuxt-seo-kit`
Update your `nuxt.config.js` to include `nuxt-seo-kit`.

```js
export default {
  modules: [
    'nuxt-seo-kit',
  ],
  runtimeConfig: {
    public: {
      siteUrl: 'https://yourwebsite.com',
      siteName: 'Your Site Name',
      siteDescription: 'Your site description',
      language: 'en',
    },
  },
}
```

### Step 3: Update `tim/nsaw.vue`
Update your `tim/nsaw.vue` file to fetch the song data from `songs.json` and use `useSeoMeta` from `nuxt-seo-kit`.

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
import { ref, onMounted } from 'vue';
import { RadioGroup, RadioGroupOption } from '@headlessui/vue';
import { useSeoMeta } from 'nuxt-seo-kit';

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
  layout: 'links',
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### JSON Structure (`songs.json`)
Make sure your `songs.json` is structured appropriately. Here's an example:

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

This setup should pull the data dynamically from `songs.json` and set the page title and description using `nuxt-seo-kit`.


<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <!-- Album Art -->
      <div class="flex justify-center mx-auto">
        <NuxtPicture
          placeholder
          class="mx-auto w-64 h-64"
          src="img/album_art/never-say-a-word.jpg"
          alt="Never Say A Word"
        ></NuxtPicture>
      </div>
      <div class="text-center mx-auto mt-4">
        <h2 class="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
          TIM WHITE
        </h2>
      </div>

      <!-- Product info -->
      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div class="text-center">
          <h1
            class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl"
          >
            {{ product.name }}
          </h1>
          <p class="mt-4 text-lg text-gray-600">{{ product.description }}</p>
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
                    v-for="service in product.services"
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
import { ref } from "vue";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";

definePageMeta({
  title: "Never Say A Word - Tim White",
});

const product = {
  name: "Never Say A Word",
  services: [
    { name: "Spotify", icon: "spotify.svg" },
    { name: "Apple Music", icon: "applemusic.svg" },
    { name: "YouTube Music", icon: "youtubemusic.svg" },
    { name: "Pandora", icon: "pandora.svg" },
    { name: "Audius", icon: "audius.svg" },
    { name: "iHeartRadio", icon: "iheartradio.svg" },
    { name: "Amazon Music", icon: "amazonmusic.svg" },
    { name: "Soundcloud", icon: "soundcloud.svg" },
  ],
  description:
    "Choose your preferred music service to listen to 'Never Say A Word' by Tim White.",
};
const selectedService = ref(product.services[0]);
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>
Lets define a song object and put the links, name, artist name, album art there and everything will come from that. 
