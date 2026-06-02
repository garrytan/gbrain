
SDFSDFSDFSDF<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
            Tim White Music Discography
          </h1>
          <p class="mt-2 text-sm text-gray-700">
            Explore Tim White's collection of songs, including their title,
            artist, length, release year, and album art.
          </p>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div class="overflow-x-auto">
          <div
            v-for="album in sortedAlbums"
            :key="album.albumName"
            class="mb-8"
          >
            <div class="flex items-center mb-4">
              <nuxt-picture
                :src="album.albumArt"
                alt="Album Art"
                width="100"
                height="100"
                class="object-cover mr-4"
              />
              <div>
                <h2 class="text-lg font-semibold text-gray-900">
                  {{ album.albumName }}
                </h2>
              </div>
            </div>
            <table class="min-w-full divide-gray-300">
              <thead class="">
                <tr>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('index')"
                  >
                    #
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('title')"
                  >
                    Song Title
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('artist')"
                  >
                    Artist
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('length')"
                  >
                    Length
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'length' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'length' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('releaseYear')"
                  >
                    Release Year
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'releaseYear' &&
                        sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'releaseYear' &&
                        sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                  >
                    <span class="sr-only">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr
                  class="hover:bg-gray-50"
                  v-for="(song, index) in album.songs"
                  :key="song.id"
                >
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ index + 1 }}
                  </td>
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ song.title }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.artist }}
                  </td>
                  <td
                    class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
                  >
                    {{ song.length }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.releaseYear }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-500">
                    <a
                      v-if="song.spotifyLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.spotifyLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/spotify.svg"
                        alt="Spotify"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.appleMusicLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.appleMusicLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/applemusic.svg"
                        alt="Apple Music"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import albums from "@/assets/albums.json";
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";

const loading = ref(false);
const error = ref(false);
const albumList = ref([]);

const sortKey = ref("releaseYear");
const sortOrder = ref("desc"); // Set default sortOrder to 'desc' for descending order

const sortedAlbums = computed(() => {
  return [...albumList.value]
    .sort((a, b) => {
      let result = 0;
      if (a.releaseYear < b.releaseYear) {
        result = -1;
      } else if (a.releaseYear > b.releaseYear) {
        result = 1;
      }
      return sortOrder.value === "asc" ? result : -result;
    })
    .map((album) => ({
      ...album,
      songs: [...album.songs], // Keep songs in original order
    }));
});

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
};

const loadAlbums = () => {
  try {
    loading.value = true;
    albumList.value = albums;
  } catch (err) {
    error.value = true;
    console.error("Error loading albums:", err);
  } finally {
    loading.value = false;
  }
};

loadAlbums();

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
modify this to use our new json file


To modify your current code to use the new JSON file with the structured data for the discography, you need to adjust the way you load and use the JSON data. Below is the updated code to integrate the structured data from the JSON file into your Nuxt.js application:

### Updated JSON File
Ensure the `static/discography.json` file contains the structured data as described earlier.

### Updated Template
```html
<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
            Tim White Music Discography
          </h1>
          <p class="mt-2 text-sm text-gray-700">
            Explore Tim White's collection of songs, including their title,
            artist, length, release year, and album art.
          </p>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div class="overflow-x-auto">
          <div
            v-for="album in sortedAlbums"
            :key="album.name"
            class="mb-8"
          >
            <div class="flex items-center mb-4">
              <nuxt-picture
                :src="album.image"
                alt="Album Art"
                width="100"
                height="100"
                class="object-cover mr-4"
              />
              <div>
                <h2 class="text-lg font-semibold text-gray-900">
                  {{ album.name }}
                </h2>
              </div>
            </div>
            <table class="min-w-full divide-gray-300">
              <thead>
                <tr>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('index')"
                  >
                    #
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('title')"
                  >
                    Song Title
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('artist')"
                  >
                    Artist
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('duration')"
                  >
                    Length
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'duration' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'duration' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('datePublished')"
                  >
                    Release Year
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'datePublished' &&
                        sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'datePublished' &&
                        sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                  >
                    <span class="sr-only">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr
                  class="hover:bg-gray-50"
                  v-for="(song, index) in album.track"
                  :key="song.name"
                >
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ index + 1 }}
                  </td>
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ song.name }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.byArtist.name }}
                  </td>
                  <td
                    class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
                  >
                    {{ formatDuration(song.duration) }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.datePublished }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-500">
                    <a
                      v-if="song.url"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.url"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/spotify.svg"
                        alt="Spotify"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.appleMusicLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.appleMusicLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/applemusic.svg"
                        alt="Apple Music"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");

const sortedAlbums = computed(() => {
  return [...albumList.value]
    .sort((a, b) => {
      let result = 0;
      if (a.datePublished < b.datePublished) {
        result = -1;
      } else if (a.datePublished > b.datePublished) {
        result = 1;
      }
      return sortOrder.value === "asc" ? result : -result;
    })
    .map((album) => ({
      ...album,
      track: [...album.track], // Keep songs in original order
    }));
});

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
};

const formatDuration = (duration) => {
  const match = duration.match(/PT(\d+)M(\d+)S/);
  if (match) {
    return `${match[1]}:${match[2].padStart(2, "0")}`;
  }
  return duration;
};

const loadAlbums = async () => {
  try {
    const { data } = await axios.get("/discography.json");
    albumList.value = data;
  } catch (err) {
    error.value = true;
    console.error("Error loading albums:", err);
  } finally


 {
    loading.value = false;
  }
};

loadAlbums();

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

### Notes:
1. **JSON File**: Ensure the `static/discography.json` file contains the structured data as per schema.org.
2. **Dynamic Loading**: The `loadAlbums` function loads the JSON data dynamically.
3. **Sorting**: The sorting functionality sorts albums by the specified key.
4. **Duration Format**: The `formatDuration` method formats the ISO 8601 duration to a more readable format.
5. **SEO Meta**: The `useSeoMeta` hook sets the SEO meta tags.

This implementation should work seamlessly with your new JSON file and ensure your data is correctly displayed and formatted in your Nuxt.js application.


{'asset_pointer': 'file-service://file-47nqVhhPFTtRrJ2AO2TmLnkW', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 834, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 945757, 'width': 2048}


The error message indicates that the JSON file is not found at the specified path. To resolve this issue, ensure the path to the JSON file is correct. 

1. **Move JSON file to the correct location**:
   - If your `discography.json` file is in the `static` directory, the correct path should be `/discography.json` instead of `/assets/discography.json`.

2. **Update the path in your script**:
   - Change the path in your `axios.get` call to `/discography.json`.

Here’s the updated `loadAlbums` function:

```javascript
const loadAlbums = async () => {
  try {
    const { data } = await axios.get("/discography.json");
    albumList.value = data;
  } catch (err) {
    error.value = true;
    console.error("Error loading albums:", err);
  } finally {
    loading.value = false;
  }
};
```

Ensure that the `discography.json` file is indeed in the `static` directory. The `static` directory should be at the root level of your Nuxt.js project, alongside `pages`, `components`, and `assets` directories.

### Full Updated Script

```html
<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
            Tim White Music Discography
          </h1>
          <p class="mt-2 text-sm text-gray-700">
            Explore Tim White's collection of songs, including their title,
            artist, length, release year, and album art.
          </p>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div class="overflow-x-auto">
          <div
            v-for="album in sortedAlbums"
            :key="album.name"
            class="mb-8"
          >
            <div class="flex items-center mb-4">
              <nuxt-picture
                :src="album.image"
                alt="Album Art"
                width="100"
                height="100"
                class="object-cover mr-4"
              />
              <div>
                <h2 class="text-lg font-semibold text-gray-900">
                  {{ album.name }}
                </h2>
              </div>
            </div>
            <table class="min-w-full divide-gray-300">
              <thead>
                <tr>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('index')"
                  >
                    #
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'index' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('title')"
                  >
                    Song Title
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'title' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('artist')"
                  >
                    Artist
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'artist' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('duration')"
                  >
                    Length
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'duration' && sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'duration' && sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                    @click="sortColumn('datePublished')"
                  >
                    Release Year
                    <ChevronUpIcon
                      v-if="
                        sortKey.value === 'datePublished' &&
                        sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'datePublished' &&
                        sortOrder.value === 'desc'
                      "
                      class="inline w-4 h-4"
                    />
                  </th>
                  <th
                    class="sticky top-[4rem] px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                  >
                    <span class="sr-only">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr
                  class="hover:bg-gray-50"
                  v-for="(song, index) in album.track"
                  :key="song.name"
                >
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ index + 1 }}
                  </td>
                  <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                    {{ song.name }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.byArtist.name }}
                  </td>
                  <td
                    class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
                  >
                    {{ formatDuration(song.duration) }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-900">
                    {{ song.datePublished }}
                  </td>
                  <td class="py-4 px-3 text-sm text-right text-gray-500">
                    <a
                      v-if="song.url"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.url"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/spotify.svg"
                        alt="Spotify"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.appleMusicLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.appleMusicLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/applemusic.svg"
                        alt="Apple Music"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");

const sortedAlbums = computed(() => {
  return [...albumList.value]
    .sort((a, b) => {
      let result = 0;
      if (a.datePublished < b.datePublished) {
        result = -1;
      } else if (a.datePublished > b.datePublished) {
        result = 1;
      }
      return sortOrder.value === "asc" ? result : -result;
    })
    .map((album) => ({
      ...album,
      track: [...album.track], // Keep songs in original order
    }));
});

const sortColumn = (key) => {
  if (sortKey.value


 === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
};

const formatDuration = (duration) => {
  const match = duration.match(/PT(\d+)M(\d+)S/);
  if (match) {
    return `${match[1]}:${match[2].padStart(2, "0")}`;
  }
  return duration;
};

const loadAlbums = async () => {
  try {
    const { data } = await axios.get("/discography.json");
    albumList.value = data;
  } catch (err) {
    error.value = true;
    console.error("Error loading albums:", err);
  } finally {
    loading.value = false;
  }
};

loadAlbums();

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

### Key Changes:
1. **Path to JSON**: Ensure the path is `/discography.json` for the JSON file in the `static` directory.
2. **Loading Logic**: The `loadAlbums` function is updated to reflect the correct path.

After ensuring these changes, reload your Nuxt.js application. If the JSON file is correctly placed in the `static` directory, it should load without errors.


add back the apple music links to the json


Sure, I'll update the JSON file to include the Apple Music links for each song where applicable.

### Updated JSON File with Apple Music Links

```json
[
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "All This Noise EP",
    "image": "img/album_art/all this noise EP 316x316bb.webp",
    "datePublished": 2015,
    "albumReleaseType": "EP",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Take Me Over", "duration": "PT3M52S", "datePublished": 2014, "byArtist": { "@type": "MusicGroup", "name": "Tim White feat. Erica Gibson" }, "url": "https://open.spotify.com/track/7A6ljVJH15cRhVSVwedLpQ?si=42f09293022a4d52", "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033" },
      { "@type": "MusicRecording", "position": 2, "name": "California", "duration": "PT3M52S", "datePublished": 2014, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/016bHqb8U09D8v8TwzCMD1?si=25e31a549f144efb", "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033" },
      { "@type": "MusicRecording", "position": 3, "name": "Trying Too Hard", "duration": "PT3M20S", "datePublished": 2015, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/3tD84mZNBlV2Npi62X7Rfl?si=f3ee4200f14336", "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033" },
      { "@type": "MusicRecording", "position": 4, "name": "Save the Night", "duration": "PT3M11S", "datePublished": 2015, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/0W9n7FF6KdyhlQ37bX84bF?si=f27c010c76f646c2", "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033" },
      { "@type": "MusicRecording", "position": 5, "name": "Become One", "duration": "PT3M12S", "datePublished": 2015, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/1DUT6K3kcn3NmHZeFmSQgL?si=7ff3ee4200f14336", "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Never Say A Word",
    "image": "img/album_art/never-say-a-word.jpg",
    "datePublished": 2024,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Never Say A Word", "duration": "PT3M18S", "datePublished": 2024, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "appleMusicLink": "" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Doge (to Mars)",
    "image": "img/album_art/doge-to-mars.webp",
    "datePublished": 2020,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Doge (to Mars)", "duration": "PT2M59S", "datePublished": 2020, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://ffm.to/doge", "appleMusicLink": "https://music.apple.com/us/album/doge-to-mars/1540417933" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Supernova Girl",
    "image": "img/album_art/supernova-girl.webp",
    "datePublished": 2020,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Supernova Girl", "duration": "PT2M33S", "datePublished": 2020, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/7gK2HYJaCGqoWmvdFsJEX6?si=a9ed587ac26047e9", "appleMusicLink": "https://music.apple.com/us/album/supernova-girl/1496249227?i=1496249237" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Seaside Heights",
    "image": "img/album_art/seaside-heights.webp",
    "datePublished": 2020,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Seaside Heights", "duration": "PT3M23S", "datePublished": 2020, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/5lYwu1v4OwmG0rhReUWZU1?si=dd554194a8584b0c", "appleMusicLink": "https://music.apple.com/us/album/seaside-heights-single/1503062729" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Love Don't Let Me Down",
    "image": "img/album_art/love-dont-let-me-down.webp",
    "datePublished": 2018,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Love Don't Let Me Down", "duration": "PT3M48S", "datePublished": 2018, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/5GPoFX9OaCZnRZyLoKWwuG?si=075c2a3dc8a943a7", "appleMusicLink": "https://music.apple.com/us/album/love-dont-let-me-down/1437671092" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Revival",
    "image": "img/album_art/revival.webp",
    "datePublished": 2017,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Revival", "duration": "PT3M21S", "datePublished": 2017, "byArtist": { "@type": "MusicGroup", "name": "Tom Fall & Tim White" }, "url": "https://open.spotify.com/track/6D8q3OZnTmUFtrRcFpU5n9?si=b40ef28d226c4b08", "appleMusicLink": "https://music.apple.com/us/album/revival-single/1143488980" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Songs About You",
    "image": "img/album_art/songs-about-you.webp",
    "datePublished": 2017,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Songs About You", "duration": "PT3M33S", "datePublished": 2017, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/3DSci0w6UEVjhbCQIFaL1i?si=90fabe8c43154587
