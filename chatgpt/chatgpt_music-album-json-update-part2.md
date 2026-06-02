
Certainly! Here is the updated Vue.js component with the added functionality to round the release date to the year and display a "Coming Soon" badge for future release dates:

```vue
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
                type="image/webp"
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
                    <span
                      v-if="new Date(song.datePublished) > new Date()"
                      class="inline-flex items-center rounded-md bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/10 ml-2"
                    >
                      Coming Soon
                    </span>
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
                    {{ formatYear(song.datePublished) }}
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
                    <a
                      v-if="song.youtubeLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.youtubeLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/youtube.svg"
                        alt="YouTube"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.pandoraLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.pandoraLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/pandora.svg"
                        alt="Pandora"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.deezerLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.deezerLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/deezer.svg"
                        alt="Deezer"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                    <a
                      v-if="song.iheartRadioLink"
                      class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                      :href="song.iheartRadioLink"
                      target="_blank"
                    >
                      <img
                        src="@/assets/icons/iheartradio.svg"
                        alt="iHeartRadio"
                        class="inline w-4 h-4 mx-1"
                      />
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div


Make the album images part of the table and make all of the albums in the same table with a single header. The albums with multiple track can be collapsable with their track listing showing when open. Then on the table instead of song title it can just same name and we'll use the album name


Certainly! Here is the updated Vue.js component with the album images included as part of the table and all albums in a single table. The albums with multiple tracks are collapsible, showing their track listings when open:

```vue
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
                <th class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
                  Album Art
                </th>
                <th
                  class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('title')"
                >
                  Name
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
                v-for="(album, albumIndex) in sortedAlbums"
                :key="album.name"
                class="hover:bg-gray-50 cursor-pointer"
                @click="toggleAlbum(albumIndex)"
              >
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  {{ albumIndex + 1 }}
                </td>
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  <nuxt-picture
                    :src="album.image"
                    type="image/webp"
                    alt="Album Art"
                    width="100"
                    height="100"
                    class="object-cover"
                  />
                </td>
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  {{ album.name }}
                </td>
                <td class="py-4 px-3 text-sm text-right text-gray-900">
                  {{ album.artist }}
                </td>
                <td
                  class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
                >
                  {{ album.duration }}
                </td>
                <td class="py-4 px-3 text-sm text-right text-gray-900">
                  {{ formatYear(album.datePublished) }}
                </td>
                <td class="py-4 px-3 text-sm text-right text-gray-500">
                  <a
                    v-if="album.url"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="album.url"
                    target="_blank"
                  >
                    <img
                      src="@/assets/icons/spotify.svg"
                      alt="Spotify"
                      class="inline w-4 h-4 mx-1"
                    />
                  </a>
                  <a
                    v-if="album.appleMusicLink"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="album.appleMusicLink"
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
              <tr
                v-if="expandedAlbum === albumIndex"
                v-for="(song, songIndex) in album.track"
                :key="song.name"
                class="hover:bg-gray-50"
              >
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  {{ songIndex + 1 }}
                </td>
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  <nuxt-picture
                    :src="album.image"
                    type="image/webp"
                    alt="Album Art"
                    width="50"
                    height="50"
                    class="object-cover"
                  />
                </td>
                <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
                  {{ song.name }}
                  <span
                    v-if="new Date(song.datePublished) > new Date()"
                    class="inline-flex items-center rounded-md bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/10 ml-2"
                  >
                    Coming Soon
                  </span>
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
                  {{ formatYear(song.datePublished) }}
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
                      alt


="Spotify"
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
                  <a
                    v-if="song.youtubeLink"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="song.youtubeLink"
                    target="_blank"
                  >
                    <img
                      src="@/assets/icons/youtube.svg"
                      alt="YouTube"
                      class="inline w-4 h-4 mx-1"
                    />
                  </a>
                  <a
                    v-if="song.pandoraLink"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="song.pandoraLink"
                    target="_blank"
                  >
                    <img
                      src="@/assets/icons/pandora.svg"
                      alt="Pandora"
                      class="inline w-4 h-4 mx-1"
                    />
                  </a>
                  <a
                    v-if="song.deezerLink"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="song.deezerLink"
                    target="_blank"
                  >
                    <img
                      src="@/assets/icons/deezer.svg"
                      alt="Deezer"
                      class="inline w-4 h-4 mx-1"
                    />
                  </a>
                  <a
                    v-if="song.iheartRadioLink"
                    class="opacity-50 hover:opacity-60 transform transition-transform duration-200"
                    :href="song.iheartRadioLink"
                    target="_blank"
                  >
                    <img
                      src="@/assets/icons/iheartradio.svg"
                      alt="iHeartRadio"
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
import axios from "axios";
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");
const expandedAlbum = ref(null);

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

const formatYear = (date) => {
  const year = new Date(date).getFullYear();
  return isNaN(year) ? date : year;
};

const toggleAlbum = (index) => {
  expandedAlbum.value = expandedAlbum.value === index ? null : index;
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

const generateJsonLd = () => {
  return {
    "@context": "http://schema.org",
    "@type": "ItemList",
    itemListElement: albumList.value.flatMap((album, albumIndex) => {
      return album.track.map((song, songIndex) => ({
        "@type": "ListItem",
        position: albumIndex * album.track.length + songIndex + 1,
        item: {
          "@type": "MusicRecording",
          name: song.name,
          byArtist: {
            "@type": "MusicGroup",
            name: song.byArtist.name,
          },
          inAlbum: {
            "@type": "MusicAlbum",
            name: album.name,
            image: album.image,
            datePublished: album.datePublished,
            albumReleaseType: album.albumReleaseType,
          },
          duration: song.duration,
          url: song.url,
          appleMusicLink: song.appleMusicLink,
        },
      }));
    }),
  };
};

useHead({
  script: [
    {
      type: "application/ld+json",
      children: JSON.stringify(generateJsonLd()),
    },
  ],
});

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

### Changes made:
1. Integrated all albums into a single table.
2. Included album images as part of the table.
3. Made the albums collapsible, displaying their track listings when expanded.
4. Updated the table to reflect the new layout, with the `Name` column showing the album name and the track titles listed under it when expanded.
5. Added logic to display a "Coming Soon" badge for future release dates.
6. Adjusted CSS classes for better visual representation of the changes.


If available we'll also display deeper, Soundcloud, & YouTube links. If any link is not available set the opacity to 0 instead of hiding it so that the layout doesn't shift.

Because our component is becoming quite large, also refactor and extract anything to smaller components if it seems logical and will improve our product


Sure! Here's the updated Vue.js component with support for additional links (Deezer, SoundCloud, and YouTube), setting the opacity to 0 for unavailable links, and refactoring into smaller components for better organization.

### Extracted Components

1. **TrackLinks.vue** - To handle displaying links with conditional opacity.
2. **TrackRow.vue** - To handle the rows for tracks, including the conditional display of links.
3. **AlbumRow.vue** - To handle the rows for albums, including the collapse functionality.

### Main Component
```vue
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
                <th class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
                  Album Art
                </th>
                <th
                  class="sticky top-[4rem] py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('title')"
                >
                  Name
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
              <AlbumRow
                v-for="(album, albumIndex) in sortedAlbums"
                :key="album.name"
                :album="album"
                :album-index="albumIndex"
                :expanded-album="expandedAlbum"
                @toggle-album="toggleAlbum"
              />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";
import AlbumRow from "@/components/AlbumRow.vue";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");
const expandedAlbum = ref(null);

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

const formatYear = (date) => {
  const year = new Date(date).getFullYear();
  return isNaN(year) ? date : year;
};

const toggleAlbum = (index) => {
  expandedAlbum.value = expandedAlbum.value === index ? null : index;
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

const generateJsonLd = () => {
  return {
    "@context": "http://schema.org",
    "@type": "ItemList",
    itemListElement: albumList.value.flatMap((album, albumIndex) => {
      return album.track.map((song, songIndex) => ({
        "@type": "ListItem",
        position: albumIndex * album.track.length + songIndex + 1,
        item: {
          "@type": "MusicRecording",
          name: song.name,
          byArtist: {
            "@type": "MusicGroup",
            name: song.byArtist.name,
          },
          inAlbum: {
            "@type": "MusicAlbum",
            name: album.name,
            image: album.image,
            datePublished: album.datePublished,
            albumReleaseType: album.albumReleaseType,
          },
          duration: song.duration,
          url: song.url,
          appleMusicLink: song.appleMusicLink,
        },
      }));
    }),
  };
};

useHead({
  script: [
    {
      type: "application/ld+json",
      children: JSON.stringify(generateJsonLd()),
    },
  ],
});

useSeoMeta({
  title: "Tim White Music",
  description: "Listen to Tim White's music on Spotify, Apple Music, and more.",
});
</script>
```

### AlbumRow.vue
```vue
<template>
  <tr class="hover:bg-gray-50
