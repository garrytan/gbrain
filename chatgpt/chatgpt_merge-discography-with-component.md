---
conversation_id: 803c1b3f-5b15-43c9-a441-c02d0c0b8f1f
created: 2024-06-08
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Merge discography with component
type: guide
updated: 2024-06-08
---

# Merge discography with component

> Conversation ID: 803c1b3f-5b15-43c9-a441-c02d0c0b8f1f
> Created: 2024-06-08T01:04:56Z
> Updated: 2024-06-08T01:05:17Z
> Messages: 2

---

## User

<template>
  <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
    <header class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
          Tim White Music Discography
        </h1>
        <p class="mt-2 text-sm text-gray-700">
          Explore Tim White's collection of songs, including their title,
          length, release year, and artist.
        </p>
      </div>
    </header>

    <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
    <div v-if="error" class="mt-2 text-sm text-red-700">
      An error occurred while fetching the discography.
    </div>

    <div v-if="!loading && !error" class="mt-8">
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-300">
          <thead class="bg-gray-50">
            <tr>
              <th
                class="sticky top-0 z-50 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50"
              >
                #
              </th>
              <th
                class="sticky top-0 z-10 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50"
              >
                Song Title
              </th>
              <th
                class="sticky top-0 z-10 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
              >
                Length
              </th>
              <th
                class="sticky top-0 z-10 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
              >
                Release Year
              </th>
              <th
                class="sticky top-0 z-10 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
              >
                Artist
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
              <td
                class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
              >
                {{ formatLength(song.length) }}
              </td>
              <td class="py-4 px-3 text-sm text-right text-gray-900">
                {{ song.releaseYear }}
              </td>
              <td class="py-4 px-3 text-sm text-right text-gray-900">
                {{ song.artist }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import axios from "axios";

export default {
  data() {
    return {
      songs: [],
      loading: false,
      error: false,
    };
  },
  computed: {
    sortedSongs() {
      return this.songs.sort((a, b) => {
        if (a.releaseDate === "Unknown") return 1;
        if (b.releaseDate === "Unknown") return -1;
        return new Date(a.releaseDate) - new Date(b.releaseDate);
      });
    },
  },
  mounted() {
    this.fetchSongs();
  },
  methods: {
    formatLength(lengthInMilliseconds) {
      if (!lengthInMilliseconds) return "Unknown";
      const lengthInSeconds = Math.floor(lengthInMilliseconds / 1000);
      const minutes = Math.floor(lengthInSeconds / 60);
      const seconds = lengthInSeconds % 60;
      return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
      )}`;
    },
    async fetchSongs() {
      const cachedSongs = localStorage.getItem("songsCache");
      if (cachedSongs) {
        this.songs = JSON.parse(cachedSongs);
        return;
      }

      this.loading = true;
      this.error = false;

      try {
        const response = await axios.get(
          "https://musicbrainz.org/ws/2/recording?artist=51972833-bb04-46b7-9401-45a5ab449ebd&fmt=json&inc=artist-credits"
        );
        this.songs = response.data.recordings.map((recording) => ({
          id: recording.id,
          title: recording.title,
          length: recording.length,
          releaseDate: recording["first-release-date"] || "Unknown",
          releaseYear: recording["first-release-date"]
            ? new Date(recording["first-release-date"]).getFullYear()
            : "Unknown",
          artist:
            recording["artist-credit"] && recording["artist-credit"][0]
              ? recording["artist-credit"][0].name
              : "Unknown",
        }));
        localStorage.setItem("songsCache", JSON.stringify(this.songs));
      } catch (error) {
        this.error = true;
        console.error("Error fetching songs:", error);
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style scoped>
th.sticky {
  position: sticky;
  top: 0;
  background-color: #f9fafb; /* same as bg-gray-50 */
  z-index: 10;
}
</style>


<template>
  <div class="flex-grow flex items-center justify-center">
    <Table></Table>
  </div>
</template>
<script>
import Table from "../components/Table.vue";
export default {
  name: "Home",
  components: {
    Table,
  },
};
</script>
<script setup>
useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>


Merge these two instead of the table being its own component

---

## Assistant

To merge the provided code and have the table as part of the main component instead of being a separate component, you can combine them as follows:

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
            length, release year, and artist.
          </p>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-300">
            <thead class="bg-gray-50">
              <tr>
                <th
                  class="sticky top-0 z-50 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  #
                </th>
                <th
                  class="sticky top-0 z-10 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  Song Title
                </th>
                <th
                  class="sticky top-0 z-10 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  Length
                </th>
                <th
                  class="sticky top-0 z-10 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  Release Year
                </th>
                <th
                  class="sticky top-0 z-10 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50"
                >
                  Artist
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
                <td
                  class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
                >
                  {{ formatLength(song.length) }}
                </td>
                <td class="py-4 px-3 text-sm text-right text-gray-900">
                  {{ song.releaseYear }}
                </td>
                <td class="py-4 px-3 text-sm text-right text-gray-900">
                  {{ song.artist }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import axios from "axios";

export default {
  name: "Home",
  data() {
    return {
      songs: [],
      loading: false,
      error: false,
    };
  },
  computed: {
    sortedSongs() {
      return this.songs.sort((a, b) => {
        if (a.releaseDate === "Unknown") return 1;
        if (b.releaseDate === "Unknown") return -1;
        return new Date(a.releaseDate) - new Date(b.releaseDate);
      });
    },
  },
  mounted() {
    this.fetchSongs();
  },
  methods: {
    formatLength(lengthInMilliseconds) {
      if (!lengthInMilliseconds) return "Unknown";
      const lengthInSeconds = Math.floor(lengthInMilliseconds / 1000);
      const minutes = Math.floor(lengthInSeconds / 60);
      const seconds = lengthInSeconds % 60;
      return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
      )}`;
    },
    async fetchSongs() {
      const cachedSongs = localStorage.getItem("songsCache");
      if (cachedSongs) {
        this.songs = JSON.parse(cachedSongs);
        return;
      }

      this.loading = true;
      this.error = false;

      try {
        const response = await axios.get(
          "https://musicbrainz.org/ws/2/recording?artist=51972833-bb04-46b7-9401-45a5ab449ebd&fmt=json&inc=artist-credits"
        );
        this.songs = response.data.recordings.map((recording) => ({
          id: recording.id,
          title: recording.title,
          length: recording.length,
          releaseDate: recording["first-release-date"] || "Unknown",
          releaseYear: recording["first-release-date"]
            ? new Date(recording["first-release-date"]).getFullYear()
            : "Unknown",
          artist:
            recording["artist-credit"] && recording["artist-credit"][0]
              ? recording["artist-credit"][0].name
              : "Unknown",
        }));
        localStorage.setItem("songsCache", JSON.stringify(this.songs));
      } catch (error) {
        this.error = true;
        console.error("Error fetching songs:", error);
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style scoped>
th.sticky {
  position: sticky;
  top: 0;
  background-color: #f9fafb; /* same as bg-gray-50 */
  z-index: 10;
}
</style>

<script setup>
useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

In this merged version, the table is no longer a separate component but is instead part of the main `Home` component. The SEO meta setup is also included in the main script section.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
