
", "appleMusicLink": "https://music.apple.com/us/album/songs-about-you-single/1552769551" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "The Deep End",
    "image": "img/album_art/the-deep-end.webp",
    "datePublished": 2017,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "The Deep End", "duration": "PT3M17S", "datePublished": 2017, "byArtist": { "@type": "MusicGroup", "name": "Cosmic Gate & Tim White" }, "url": "https://open.spotify.com/track/2ytPvrbkbKJnzQbGSoPNy8?si=e1b442131f7642f7", "appleMusicLink": "https://music.apple.com/us/album/the-deep-end/1206952413?i=1206952431" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Wheels Up",
    "image": "img/album_art/wheels-up.webp",
    "datePublished": 2017,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Wheels Up", "duration": "PT3M12S", "datePublished": 2017, "byArtist": { "@type": "MusicGroup", "name": "Lynx & Tim White" }, "url": "https://open.spotify.com/track/4u4k9y0gdlR9tiI9cSOmMU?si=65927cf2b2884d5d", "appleMusicLink": "https://music.apple.com/us/album/wheels-up-single/1581776680" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Sober",
    "image": "img/album_art/sober.webp",
    "datePublished": 2016,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Sober", "duration": "PT3M29S", "datePublished": 2016, "byArtist": { "@type": "MusicGroup", "name": "Tom Fall & Jochen Miller feat. Tim White" }, "url": "https://open.spotify.com/track/7B7BtEb2X1eIxo0l8vfMFT?si=76f2802bf95840ed", "appleMusicLink": "https://music.apple.com/us/album/sober-feat-tim-white-single/1164445824" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "This is Love",
    "image": "img/album_art/this-is-love.webp",
    "datePublished": 2020,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "This is Love", "duration": "PT3M32S", "datePublished": 2020, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/4Pxl4bqU6NAP71m4MhRm5u?si=fc13a136651043d3", "appleMusicLink": "https://music.apple.com/us/album/this-is-love-single/1506810145" }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Tomorrow Sounds",
    "image": "img/album_art/tomorrow-sounds.webp",
    "datePublished": 2019,
    "albumReleaseType": "Single",
    "track": [
      { "@type": "MusicRecording", "position": 1, "name": "Tomorrow Sounds", "duration": "PT3M45S", "datePublished": 2019, "byArtist": { "@type": "MusicGroup", "name": "Tim White" }, "url": "https://open.spotify.com/track/16tlpINW59Ae2XBx9Bbtgs?si=856022689414481d", "appleMusicLink": "https://music.apple.com/us/album/supernova-girl-single/1496249227" }
    ]
  }
]
```

### Updated Nuxt.js Code

Make sure the path to the JSON file is correct in your Nuxt.js component and the code for loading the JSON file remains the same as updated before:

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
                    class="sticky top-[4rem] px-3 py-3.


5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
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

Ensure your `discography.json` file is correctly placed in the `static` directory and contains the updated Apple Music links. This should resolve the issue and correctly load and display the discography data in your Nuxt.js application.


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
          <div v-for="album in sortedAlbums" :key="album.name" class="mb-8">
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
                        sortKey.value === 'duration' &&
                        sortOrder.value === 'asc'
                      "
                      class="inline w-4 h-4"
                    />
                    <ChevronDownIcon
                      v-if="
                        sortKey.value === 'duration' &&
                        sortOrder.value === 'desc'
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


now lets put the schema in our Nuxt seo so that google picks up the structured data and we pull all our songs from the existing discography.json file so we dont duplicate our list of music


To include the structured data in your Nuxt.js application and ensure that Google picks it up, you can dynamically generate the JSON-LD schema from your `discography.json` file and add it to the `<head>` of your Nuxt.js component.

Here's how you can update your code to achieve this:

1. **Load the JSON data from `discography.json`.**
2. **Generate the JSON-LD schema dynamically.**
3. **Add the JSON-LD to the `<head>` using Nuxt's `head` method.**

### Updated Nuxt.js Component

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
          <div v-for="album in sortedAlbums" :key="album.name" class="mb-8">
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
    albumList


.value = data;
  } catch (err) {
    error.value = true;
    console.error("Error loading albums:", err);
  } finally {
    loading.value = false;
  }
};

loadAlbums();

const generateJsonLd = () => {
  return {
    "@context": "http://schema.org",
    "@type": "ItemList",
    "itemListElement": albumList.value.flatMap((album, albumIndex) => {
      return album.track.map((song, songIndex) => ({
        "@type": "ListItem",
        "position": albumIndex * album.track.length + songIndex + 1,
        "item": {
          "@type": "MusicRecording",
          "name": song.name,
          "byArtist": {
            "@type": "MusicGroup",
            "name": song.byArtist.name
          },
          "inAlbum": {
            "@type": "MusicAlbum",
            "name": album.name,
            "image": album.image,
            "datePublished": album.datePublished,
            "albumReleaseType": album.albumReleaseType
          },
          "duration": song.duration,
          "url": song.url,
          "appleMusicLink": song.appleMusicLink
        }
      }));
    })
  };
};

useHead({
  script: [
    {
      type: "application/ld+json",
      children: JSON.stringify(generateJsonLd())
    }
  ]
});

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

### Explanation:
1. **Data Loading**: The `loadAlbums` function loads the discography JSON data from the static directory.
2. **Sorted Albums**: The albums are sorted based on the selected column and order.
3. **Schema Generation**: The `generateJsonLd` function generates the JSON-LD structured data based on the loaded album data.
4. **SEO and Structured Data**: The `useHead` and `useSeoMeta` functions are used to add the structured data to the `<head>` section of the HTML for SEO purposes.

By integrating the structured data directly into the `<head>` of your Nuxt.js application, Google and other search engines can easily pick up the information, improving your SEO.


use nuxt seo


To use


To incorporate structured data with Nuxt SEO, you can use the `useHead` function from the `@vueuse/head` library to add the JSON-LD script dynamically. Here’s how to achieve that:

1. **Load the JSON data from `discography.json`.**
2. **Generate the JSON-LD schema dynamically.**
3. **Add the JSON-LD to the `<head>` using the `useHead` function.**

### Updated Nuxt.js Component

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
          <div v-for="album in sortedAlbums" :key="album.name" class="mb-8">
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
                       


## See Also
- [[chatgpt/chatgpt_reorder-json-by-id-part1]]
- [[chatgpt/chatgpt_reorder-json-by-id-part2]]
- [[chatgpt/chatgpt_music-album-json-update-part3]]
- [[chatgpt/chatgpt_accident-liability-and-insurance-part3]]
- [[chatgpt/chatgpt_agentic-os-for-artists-part3]]
