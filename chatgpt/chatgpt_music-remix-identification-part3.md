
To incorporate Vue Heroicons for the sorting arrows and to conditionally display music service icons only if the links are available, you can use the following approach:

1. Install Heroicons for Vue.
2. Update the template to use Heroicons and conditional rendering for the service icons.

Here is how you can update your component:

1. First, install the `@heroicons/vue` package:
   ```sh
   npm install @heroicons/vue
   ```

2. Update your Vue component:

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
            artist, length, and release year.
          </p>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-gray-300">
            <thead class="">
              <tr>
                <th
                  class="sticky top-[4rem] z-50 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('index')"
                >
                  #
                  <ChevronUpIcon
                    v-if="sortKey.value === 'index' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'index' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-[4rem] z-50 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('title')"
                >
                  Song Title
                  <ChevronUpIcon
                    v-if="sortKey.value === 'title' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'title' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-[4rem] z-50 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('artist')"
                >
                  Artist
                  <ChevronUpIcon
                    v-if="sortKey.value === 'artist' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'artist' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-[4rem] z-50 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('length')"
                >
                  Length
                  <ChevronUpIcon
                    v-if="sortKey.value === 'length' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'length' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-[4rem] z-50 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('releaseYear')"
                >
                  Release Year
                  <ChevronUpIcon
                    v-if="sortKey.value === 'releaseYear' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'releaseYear' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-[4rem] z-50 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  <span class="sr-only">Links</span>
                </th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <tr
                class="hover:bg-gray-50"
                v-for="(song, index) in sortedSongs"
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
</template>

<script setup>
import { ref, computed } from "vue";
import songs from "@/assets/songs.json";
import { ChevronUpIcon, ChevronDownIcon } from '@heroicons/vue/solid';

const loading = ref(false);
const error = ref(false);
const songList = ref([]);

const sortKey = ref("releaseYear");
const sortOrder = ref("asc");

const sortedSongs = computed(() => {
  return [...songList.value].sort((a, b) => {
    let result = 0;
    if (a[sortKey.value] < b[sortKey.value]) {
      result = -1;
    } else if (a[sortKey.value] > b[sortKey.value]) {
      result = 1;
    }
    return sortOrder.value === "asc" ? result : -result;
  });
});

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
};

const loadSongs = () => {
  try {
    loading.value = true;
    songList.value = songs;
  } catch (err) {
    error.value = true;
    console.error("Error loading songs:", err);
  } finally {
    loading.value = false;
  }
};

loadSongs();

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
<style>
/* No additional CSS needed */
</style>
```

### Explanation:

1. **Heroicons Import**: Imported `ChevronUpIcon` and `ChevronDownIcon` from `@heroicons/vue/solid`.
2. **Conditional Rendering**: Used `v-if` to conditionally render the icons based on the availability of the links.
3. **Chevron Icons**: Added the `ChevronUpIcon` and `ChevronDownIcon` next to the column headers based on the sorting order.

This approach ensures that the music service icons are only displayed if the links are available, and the sorting order is clearly indicated using chevron icons.
