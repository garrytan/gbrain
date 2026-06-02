
 cursor-pointer" @click="toggleAlbum">
    <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ albumIndex + 1 }}</td>
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
    <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ album.name }}</td>
    <td class="py-4 px-3 text-sm text-right text-gray-900">{{ album.artist }}</td>
    <td
      class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900"
    >
      {{ album.duration }}
    </td>
    <td class="py-4 px-3 text-sm text-right text-gray-900">
      {{ formatYear(album.datePublished) }}
    </td>
    <td class="py-4 px-3 text-sm text-right text-gray-500">
      <TrackLinks :song="album" />
    </td>
    <tr
      v-if="expandedAlbum === albumIndex"
      v-for="(song, songIndex) in album.track"
      :key="song.name"
      class="hover:bg-gray-50"
    >
      <TrackRow :song="song" :song-index="songIndex" :album="album" />
    </tr>
  </tr>
</template>

<script setup>
import TrackLinks from "@/components/TrackLinks.vue";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps({
  album: Object,
  albumIndex: Number,
  expandedAlbum: Number,
});

const emit = defineEmits(["toggle-album"]);

const toggleAlbum = () => {
  emit("toggle-album", albumIndex);
};

const formatYear = (date) => {
  const year = new Date(date).getFullYear();
  return isNaN(year) ? date : year;
};
</script>
```

### TrackRow.vue
```vue
<template>
  <tr>
    <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ songIndex + 1 }}</td>
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
      <TrackLinks :song="song" />
    </td>
  </tr>
</template>

<script setup>
import TrackLinks from "@/components/TrackLinks.vue";

const props = defineProps({
  song: Object,
  songIndex: Number,
  album: Object,
});

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
</script>
```

### TrackLinks.vue
```vue
<template>
  <div>
    <a
      v-if="song.url"
      :style="{ opacity: song.url ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.appleMusicLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.youtubeLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.pandoraLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.deezerLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      v-if="song.soundCloudLink"
      :style="{ opacity: song.soundCloudLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
      :href="song.soundCloudLink"
      target="_blank"
    >
      <img
        src="@/assets/icons/soundcloud.svg"
        alt="SoundCloud"
        class="inline w-4 h-4 mx-1"
      />
    </a>
    <a
      v-if="song.iheartRadioLink"
      :style="{ opacity: song.iheartRadioLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
      :href="song.iheartRadioLink"
      target="_blank"
    >
      <img
        src="@/assets/icons/iheartradio.svg"
        alt="iHeartRadio"
        class="inline w-4 h-4 mx-1"
      />
    </a>
  </div>
</template>

<script setup>
const props = defineProps({
  song: Object,
});
</script>
```

### Additional Notes:
- Ensure the paths to the icons (`@/assets/icons/*.svg`) are correct based on your project structure.
- Make sure to update the JSON structure in `discography.json` to include the new links (YouTube, Pandora, Deezer, SoundCloud, iHeartRadio) if they are not already present.


Show the full albumrow.vue component


Certainly! Here is the full `AlbumRow.vue` component:

### AlbumRow.vue
```vue
<template>
  <tr>
    <td colspan="7" class="py-4 pl-4 pr-3 text-sm text-gray-900">
      <div class="flex items-center justify-between cursor-pointer" @click="toggleAlbum">
        <div class="flex items-center">
          <nuxt-picture
            :src="album.image"
            type="image/webp"
            alt="Album Art"
            width="100"
            height="100"
            class="object-cover mr-4"
          />
          <div>
            <h2 class="text-lg font-semibold text-gray-900">{{ album.name }}</h2>
            <p class="text-sm text-gray-600">{{ album.artist }}</p>
          </div>
        </div>
        <div>
          <span class="text-sm text-gray-900">{{ formatYear(album.datePublished) }}</span>
          <ChevronUpIcon
            v-if="expandedAlbum === albumIndex"
            class="inline w-4 h-4 ml-2"
          />
          <ChevronDownIcon
            v-else
            class="inline w-4 h-4 ml-2"
          />
        </div>
      </div>
    </td>
  </tr>
  <tr
    v-if="expandedAlbum === albumIndex"
    v-for="(song, songIndex) in album.track"
    :key="song.name"
    class="hover:bg-gray-50"
  >
    <TrackRow :song="song" :song-index="songIndex" :album="album" />
  </tr>
</template>

<script setup>
import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/vue/16/solid";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps({
  album: Object,
  albumIndex: Number,
  expandedAlbum: Number,
});

const emit = defineEmits(["toggle-album"]);

const toggleAlbum = () => {
  emit("toggle-album", albumIndex);
};

const formatYear = (date) => {
  const year = new Date(date).getFullYear();
  return isNaN(year) ? date : year;
};
</script>

<style scoped>
.album-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.album-details {
  display: flex;
  align-items: center;
}
</style>
```

### Additional Components
Make sure you have the `TrackRow.vue` and `TrackLinks.vue` components as well:

### TrackRow.vue
```vue
<template>
  <tr>
    <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ songIndex + 1 }}</td>
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
      <TrackLinks :song="song" />
    </td>
  </tr>
</template>

<script setup>
import TrackLinks from "@/components/TrackLinks.vue";

const props = defineProps({
  song: Object,
  songIndex: Number,
  album: Object,
});

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
</script>
```

### TrackLinks.vue
```vue
<template>
  <div>
    <a
      v-if="song.url"
      :style="{ opacity: song.url ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.appleMusicLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.youtubeLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.pandoraLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      :style="{ opacity: song.deezerLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
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
      v-if="song.soundCloudLink"
      :style="{ opacity: song.soundCloudLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
      :href="song.soundCloudLink"
      target="_blank"
    >
      <img
        src="@/assets/icons/soundcloud.svg"
        alt="SoundCloud"
        class="inline w-4 h-4 mx-1"
      />
    </a>
    <a
      v-if="song.iheartRadioLink"
      :style="{ opacity: song.iheartRadioLink ? 1 : 0 }"
      class="hover:opacity-60 transform transition-transform duration-200"
      :href="song.iheartRadioLink"
      target="_blank"
    >
      <img
        src="@/assets/icons/iheartradio.svg"
        alt="iHeartRadio"
        class="inline w-4 h-4 mx-1"
      />
    </a>
  </div>
</template>

<script setup>
const props = defineProps({
  song: Object,
});
</script>
```

With these components, your main component `Discography.vue` should be more organized and easier to maintain. This structure allows each part of the table to be modular and reusable.


{'asset_pointer': 'file-service://file-8zPDCXn7mgwHZeR0HTbOtmdw', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 643, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 200100, 'width': 1536}


Based on the screenshot you provided, it seems like the album rows are displaying correctly, but there might be an issue with how the songs are displayed when an album is expanded. Additionally, it looks like there's an error related to the `track` attribute in the console.

To address this issue, let's ensure the component structure and logic are correctly implemented.

### Ensure Proper Data Structure
First, ensure your `discography.json` file has the correct structure:
```json
[
  {
    "name": "All This Noise EP",
    "image": "img/album_art/all this noise EP 316x316bb.webp",
    "datePublished": "2015",
    "albumReleaseType": "EP",
    "track": [
      {
        "name": "Take Me Over",
        "duration": "PT3M52S",
        "datePublished": "2014",
        "byArtist": { "name": "Tim White feat. Erica Gibson" },
        "url": "https://open.spotify.com/track/7A6ljVJH15cRhVSVwedLpQ?si=42f09293022a4d52",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      }
      // other tracks
    ]
  }
  // other albums
]
```

### Ensure Component Implementation

#### Main Component (Discography.vue)
Ensure the main component is correctly structured:
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
                 


Our discography is like this
[
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "All This Noise EP",
    "image": "img/album_art/all this noise EP 316x316bb.webp",
    "datePublished": 2015,
    "albumReleaseType": "EP",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Take Me Over",
        "duration": "PT3M52S",
        "datePublished": "2014-05-06",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White feat. Erica Gibson"
        },
        "recordLabel": "TALUS",
        "url": "https://open.spotify.com/track/7A6ljVJH15cRhVSVwedLpQ?si=42f09293022a4d52",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      },
      {
        "@type": "MusicRecording",
        "position": 2,
        "name": "California",
        "duration": "PT3M52S",
        "datePublished": "2014-10-21",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "TALUS",
        "url": "https://open.spotify.com/track/016bHqb8U09D8v8TwzCMD1?si=25e31a549f144efb",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      },
      {
        "@type": "MusicRecording",
        "position": 3,
        "name": "Trying Too Hard",
        "duration": "PT3M20S",
        "datePublished": "2015-07-17",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "TALUS",
        "url": "https://open.spotify.com/track/3tD84mZNBlV2Npi62X7Rfl?si=f3ee4200f14336",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      },
      {
        "@type": "MusicRecording",
        "position": 4,
        "name": "Save the Night",
        "duration": "PT3M11S",
        "datePublished": "2015-08-14",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "TALUS",
        "url": "https://open.spotify.com/track/0W9n7FF6KdyhlQ37bX84bF?si=f27c010c76f646c2",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      },
      {
        "@type": "MusicRecording",
        "position": 5,
        "name": "Become One",
        "duration": "PT3M12S",
        "datePublished": "2015-08-14",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "TALUS",
        "url": "https://open.spotify.com/track/1DUT6K3kcn3NmHZeFmSQgL?si=7ff3ee4200f14336",
        "appleMusicLink": "https://music.apple.com/us/album/all-this-noise-ep/1032370033"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Never Say A Word",
    "image": "img/album_art/never-say-a-word.jpg",
    "datePublished": "2024-06-21",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Never Say A Word",
        "duration": "PT3M18S",
        "datePublished": "2024-06-21",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "appleMusicLink": ""
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Doge (to Mars)",
    "image": "img/album_art/doge-to-mars.webp",
    "datePublished": "2021-02-19",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Doge (to Mars)",
        "duration": "PT2M59S",
        "datePublished": "2021-02-19",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "A7X3",
        "url": "https://ffm.to/doge",
        "appleMusicLink": "https://music.apple.com/us/album/doge-to-mars-single/1554927259"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Supernova Girl",
    "image": "img/album_art/supernova-girl.webp",
    "datePublished": "2020-03-06",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Supernova Girl",
        "duration": "PT2M33S",
        "datePublished": "2020-03-06",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "url": "https://open.spotify.com/track/7gK2HYJaCGqoWmvdFsJEX6?si=a9ed587ac26047e9",
        "appleMusicLink": "https://music.apple.com/us/album/supernova-girl/1496249227?i=1496249237"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Seaside Heights",
    "image": "img/album_art/seaside-heights.webp",
    "datePublished": "2020-05-15",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Seaside Heights",
        "duration": "PT3M23S",
        "datePublished": "2020-05-15",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "url": "https://open.spotify.com/track/5lYwu1v4OwmG0rhReUWZU1?si=dd554194a8584b0c",
        "appleMusicLink": "https://music.apple.com/us/album/seaside-heights-single/1503062729"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Love Don't Let Me Down",
    "image": "img/album_art/love-dont-let-me-down.webp",
    "datePublished": "2018-01-12",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Love Don't Let Me Down",
        "duration": "PT3M48S",
        "datePublished": "2018-01-12",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "url": "https://open.spotify.com/track/5GPoFX9OaCZnRZyLoKWwuG?si=075c2a3dc8a943a7",
        "appleMusicLink": "https://music.apple.com/us/album/love-dont-let-me-down/1437671092"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Revival",
    "image": "img/album_art/revival.webp",
    "datePublished": "2016-09-12",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Revival",
        "duration": "PT3M21S",
        "datePublished": "2016-09-12",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tom Fall & Tim White"
        },
        "recordLabel": "Armada Trice",
        "url": "https://open.spotify.com/track/6D8q3OZnTmUFtrRcFpU5n9?si=b40ef28d226c4b08",
        "appleMusicLink": "https://music.apple.com/us/album/revival-single/1143488980"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Songs About You",
    "image": "img/album_art/songs-about-you.webp",
    "datePublished": "2017-06-16",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Songs About You",
        "duration": "PT3M33S",
        "datePublished": "2017-06-16",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "A7X3",
        "url": "https://open.spotify.com/track/3DSci0w6UEVjhbCQIFaL1i?si=90fabe8c43154587",
        "appleMusicLink": "https://music.apple.com/us/album/songs-about-you-single/1552769551"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "The Deep End",
    "image": "img/album_art/the-deep-end.webp",
    "datePublished": "2017-02-17",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "The Deep End",
        "duration": "PT3M17S",
        "datePublished": "2017-02-17",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Cosmic Gate & Tim White"
        },
        "recordLabel": "Wake Your Mind Records",
        "url": "https://open.spotify.com/track/2ytPvrbkbKJnzQbGSoPNy8?si=e1b442131f7642f7",
        "appleMusicLink": "https://music.apple.com/us/album/the-deep-end/1206952413?i=1206952431"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Wheels Up",
    "image": "img/album_art/wheels-up.webp",
    "datePublished": "2018-04-27",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Wheels Up",
        "duration": "PT3M12S",
        "datePublished": "2018-04-27",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Lynx & Tim White"
        },
        "recordLabel": "Digital Movement Records",
        "url": "https://open.spotify.com/track/4u4k9y0gdlR9tiI9cSOmMU?si=65927cf2b2884d5d",
        "appleMusicLink": "https://music.apple.com/us/album/wheels-up-single/1581776680"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Sober",
    "image": "img/album_art/sober.webp",
    "datePublished": "2016-11-07",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Sober",
        "duration": "PT3M29S",
        "datePublished": "2016-11-07",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tom Fall & Jochen Miller feat. Tim White"
        },
        "recordLabel": "Armada Zouk",
        "url": "https://open.spotify.com/track/7B7BtEb2X1eIxo0l8vfMFT?si=76f2802bf95840ed",
        "appleMusicLink": "https://music.apple.com/us/album/sober-feat-tim-white-single/1164445824"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "This is Love",
    "image": "img/album_art/this-is-love.webp",
    "datePublished": "2020-01-31",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "This is Love",
        "duration": "PT3M32S",
        "datePublished": "2020-01-31",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "url": "https://open.spotify.com/track/4Pxl4bqU6NAP71m4MhRm5u?si=fc13a136651043d3",
        "appleMusicLink": "https://music.apple.com/us/album/this-is-love-single/1506810145"
      }
    ]
  },
  {
    "@context": "http://schema.org",
    "@type": "MusicAlbum",
    "name": "Tomorrow Sounds",
    "image": "img/album_art/tomorrow-sounds.webp",
    "datePublished": "2020-04-03",
    "albumReleaseType": "Single",
    "track": [
      {
        "@type": "MusicRecording",
        "position": 1,
        "name": "Tomorrow Sounds",
        "duration": "PT3M45S",
        "datePublished": "2020-04-03",
        "byArtist": {
          "@type": "MusicGroup",
          "name": "Tim White"
        },
        "recordLabel": "Tim White Limited",
        "url": "https://open.spotify.com/track/16tlpINW59Ae2XBx9Bbtgs?si=856022689414481d",
        "appleMusicLink": "https://music.apple.com/us/album/supernova-girl-single/1496249227"
      }
    ]
  }
]



Thank you for providing the discography structure. Based on the provided data, we will adjust the main component, `AlbumRow.vue`, and `TrackRow.vue` to handle this structure and ensure that the songs are displayed correctly when an album is expanded.

### Main Component (Discography.vue)
Ensure the main component is correctly structured:
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
                  @click="sortColumn('name')"
                >
                  Name
                  <ChevronUpIcon
                    v-if="
                      sortKey.value === 'name' && sortOrder.value === 'asc'
                    "
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="
                      sortKey.value === 'name' && sortOrder.value === 'desc'
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
  <tr>
    <td colspan="7" class="py-4 pl-4 pr-3 text-sm text-gray-900">
      <div class="flex items-center justify-between cursor-pointer" @click="toggleAlbum">
        <div class="flex items


**Topic:** [[chatgpt-clusters/jovie_music]]
