
-center">
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

With these components, your main component `Discography.vue` should be more organized and easier to maintain. This structure allows each part of the table to be modular and reusable. Adjust the icon paths and styles as needed based on your project's setup.


{'asset_pointer': 'file-service://file-bCEQ84lyFo9rterjFXrShpx9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 712, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 142489, 'width': 472}


The error message indicates that `albumIndex` is not defined in the `toggleAlbum` method of `AlbumRow.vue`. Let's ensure that `albumIndex` is correctly passed and handled in the component.

### Updated `AlbumRow.vue`

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
  emit("toggle-album", props.albumIndex);
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

### Ensure Correct Props in `Discography.vue`

Ensure that `albumIndex` is correctly passed in the `Discography.vue` file:

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

### Summary
- Fixed the `albumIndex` not defined issue in the `toggleAlbum` method of `AlbumRow.vue` by properly defining and passing `albumIndex` as a prop.
- Made sure that `Discography.vue` correctly passes `albumIndex` to `AlbumRow.vue`.

This should resolve the error and allow the component to work correctly. If there are any additional errors or issues, please provide further details.


{'asset_pointer': 'file-service://file-13BDeBUsFunTLxZT2G3o1LSI', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 790, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 105514, 'width': 1486}
{'asset_pointer': 'file-service://file-5bcgRoaeJccwVpix0Tin2Miu', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 636, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 118396, 'width': 1362}
Fix the style issues


To address the style issues and ensure a consistent layout for the expanded album tracks, we can refine the styles and structure in the components. Here are the steps to fix the styling issues:

### Main Component (Discography.vue)

Ensure that the main component structure is consistent and logical:

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
          <table class="min-w-full divide-y divide-gray-300">
            <thead>
              <tr>
                <th
                  class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
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
                <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
                  Album Art
                </th>
                <th
                  class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('name')"
                >
                  Name
                  <ChevronUpIcon
                    v-if="sortKey.value === 'name' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'name' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
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
                  class="sticky top-0 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('duration')"
                >
                  Length
                  <ChevronUpIcon
                    v-if="sortKey.value === 'duration' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'duration' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th
                  class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
                  @click="sortColumn('datePublished')"
                >
                  Release Year
                  <ChevronUpIcon
                    v-if="sortKey.value === 'datePublished' && sortOrder.value === 'asc'"
                    class="inline w-4 h-4"
                  />
                  <ChevronDownIcon
                    v-if="sortKey.value === 'datePublished' && sortOrder.value === 'desc'"
                    class="inline w-4 h-4"
                  />
                </th>
                <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
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

Ensure that the component structure and styling are consistent:

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
          <


div>
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
  emit("toggle-album", props.albumIndex);
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

### TrackRow.vue

Ensure that the component structure and styling are consistent:

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

Ensure that the component structure and styling are consistent:

```vue
<template>
  <div>
    <a
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

### Ensure Consistency and Alignment

Make sure all components have consistent styles and proper alignment. Adjust any padding, margins, and other CSS properties as necessary to ensure a clean and consistent layout across the discography page.


Ok let's display everything in a single table with all tracks viewable at once. We will add a column for album name. And this will be our new table view. The current view will be our album view. We will have a toggle up top to switch between the two.


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_music-album-json-update-part1]]
- [[chatgpt/chatgpt_music-album-json-update-part2]]
- [[chatgpt/chatgpt_music-album-json-update-part3]]
- [[chatgpt/chatgpt_music-album-json-update-part5]]
- [[chatgpt/chatgpt_update-component-for-weight-logs-part4]]
