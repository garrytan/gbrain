
To create a toggle for switching between the "Album View" and the "Table View" and display all tracks in a single table, we will need to make a few updates to our components and overall structure.

### Step 1: Update `Discography.vue` to Include Toggle and Handle Views

First, let's update `Discography.vue` to include a toggle switch and handle switching between views.

```vue
<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center justify-between">
        <div class="sm:flex-auto">
          <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
            Tim White Music Discography
          </h1>
          <p class="mt-2 text-sm text-gray-700">
            Explore Tim White's collection of songs, including their title,
            artist, length, release year, and album art.
          </p>
        </div>
        <div class="mt-4 sm:mt-0">
          <button
            @click="toggleView"
            class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
          >
            Switch to {{ view === 'album' ? 'Table View' : 'Album View' }}
          </button>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div v-if="view === 'album'">
          <AlbumView :albums="sortedAlbums" :expanded-album="expandedAlbum" @toggle-album="toggleAlbum" />
        </div>
        <div v-else>
          <TrackTableView :albums="sortedAlbums" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import AlbumView from "@/components/AlbumView.vue";
import TrackTableView from "@/components/TrackTableView.vue";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");
const expandedAlbum = ref(null);
const view = ref("album"); // new state to track the current view

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

const toggleView = () => {
  view.value = view.value === "album" ? "table" : "album";
};

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
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
</script>
```

### Step 2: Create `AlbumView.vue` for Album View

Refactor the album view into its own component:

```vue
<template>
  <div>
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
                v-if="sortKey === 'index' && sortOrder === 'asc'"
                class="inline w-4 h-4"
              />
              <ChevronDownIcon
                v-if="sortKey === 'index' && sortOrder === 'desc'"
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
                v-if="sortKey === 'name' && sortOrder === 'asc'"
                class="inline w-4 h-4"
              />
              <ChevronDownIcon
                v-if="sortKey === 'name' && sortOrder === 'desc'"
                class="inline w-4 h-4"
              />
            </th>
            <th
              class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
              @click="sortColumn('artist')"
            >
              Artist
              <ChevronUpIcon
                v-if="sortKey === 'artist' && sortOrder === 'asc'"
                class="inline w-4 h-4"
              />
              <ChevronDownIcon
                v-if="sortKey === 'artist' && sortOrder === 'desc'"
                class="inline w-4 h-4"
              />
            </th>
            <th
              class="sticky top-0 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
              @click="sortColumn('duration')"
            >
              Length
              <ChevronUpIcon
                v-if="sortKey === 'duration' && sortOrder === 'asc'"
                class="inline w-4 h-4"
              />
              <ChevronDownIcon
                v-if="sortKey === 'duration' && sortOrder === 'desc'"
                class="inline w-4 h-4"
              />
            </th>
            <th
              class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50 cursor-pointer"
              @click="sortColumn('datePublished')"
            >
              Release Year
              <ChevronUpIcon
                v-if="sortKey === 'datePublished' && sortOrder === 'asc'"
                class="inline w-4 h-4"
              />
              <ChevronDownIcon
                v-if="sortKey === 'datePublished' && sortOrder === 'desc'"
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
            v-for="(album, albumIndex) in albums"
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
</template>

<script setup>
import { ref } from "vue";
import AlbumRow from "@/components/AlbumRow.vue";

const props = defineProps({
  albums: Array,
  expandedAlbum: Number,
});

const emit = defineEmits(["toggle-album"]);

const sortKey = ref("datePublished");
const sortOrder = ref("desc");

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
};

const toggleAlbum = (index) => {
  emit("toggle-album", index);
};
</script>
```

### Step 3: Create `TrackTableView.vue` for Table View

Create a new component to display all tracks in a single table view:

```vue
<template>
  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-300">
      <thead>
        <tr>
          <th
            class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50"
          >
           


 #
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Art
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Name
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Name
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Artist
          </th>
          <th class="sticky top-0 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Length
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Release Year
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            <span class="sr-only">Links</span>
          </th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        <tr
          v-for="(song, songIndex) in allTracks"
          :key="song.name"
          class="hover:bg-gray-50"
        >
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ songIndex + 1 }}</td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
            <nuxt-picture
              :src="song.album.image"
              type="image/webp"
              alt="Album Art"
              width="50"
              height="50"
              class="object-cover"
            />
          </td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ song.album.name }}</td>
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
          <td class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900">
            {{ formatDuration(song.duration) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-900">
            {{ formatYear(song.datePublished) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-500">
            <TrackLinks :song="song" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import TrackLinks from "@/components/TrackLinks.vue";

const props = defineProps({
  albums: Array,
});

const allTracks = computed(() => {
  return props.albums.flatMap((album) =>
    album.track.map((track) => ({ ...track, album }))
  );
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

### Summary

1. **Discography.vue**: Add a toggle button to switch between views and load either the `AlbumView` or `TrackTableView`.
2. **AlbumView.vue**: Refactor the existing album view into a separate component.
3. **TrackTableView.vue**: Create a new component to display all tracks in a single table with columns for album art and album name.
4. **TrackLinks.vue**: Ensure that the song links are correctly displayed.

This setup provides a toggle switch for switching between album and table views, displaying all tracks in a single table with columns for album art and album name.


Show the full track table view component


Here is the full `TrackTableView.vue` component that will display all tracks in a single table, including columns for album art and album name. This component will be used when the user toggles to the "Table View."

```vue
<template>
  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-300">
      <thead>
        <tr>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            #
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Art
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Name
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Name
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Artist
          </th>
          <th class="sticky top-0 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Length
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Release Year
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            <span class="sr-only">Links</span>
          </th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        <tr
          v-for="(song, songIndex) in allTracks"
          :key="song.name"
          class="hover:bg-gray-50"
        >
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ songIndex + 1 }}</td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
            <nuxt-picture
              :src="song.album.image"
              type="image/webp"
              alt="Album Art"
              width="50"
              height="50"
              class="object-cover"
            />
          </td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ song.album.name }}</td>
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
          <td class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900">
            {{ formatDuration(song.duration) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-900">
            {{ formatYear(song.datePublished) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-500">
            <TrackLinks :song="song" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed } from "vue";
import TrackLinks from "@/components/TrackLinks.vue";

const props = defineProps({
  albums: Array,
});

const allTracks = computed(() => {
  return props.albums.flatMap((album) =>
    album.track.map((track) => ({ ...track, album }))
  );
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

### Step 4: Update `Discography.vue` to Use the New Components

Finally, ensure that `Discography.vue` correctly uses the new components and handles the toggle logic:

```vue
<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center justify-between">
        <div class="sm:flex-auto">
          <h1 class="text-xl mt-10 font-semibold leading-6 text-gray-900">
            Tim White Music Discography
          </h1>
          <p class="mt-2 text-sm text-gray-700">
            Explore Tim White's collection of songs, including their title,
            artist, length, release year, and album art.
          </p>
        </div>
        <div class="mt-4 sm:mt-0">
          <button
            @click="toggleView"
            class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
          >
            Switch to {{ view === 'album' ? 'Table View' : 'Album View' }}
          </button>
        </div>
      </header>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div v-if="view === 'album'">
          <AlbumView :albums="sortedAlbums" :expanded-album="expandedAlbum" @toggle-album="toggleAlbum" />
        </div>
        <div v-else>
          <TrackTableView :albums="sortedAlbums" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import AlbumView from "@/components/AlbumView.vue";
import TrackTableView from "@/components/TrackTableView.vue";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");
const expandedAlbum = ref(null);
const view = ref("album"); // new state to track the current view

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

const toggleView = () => {
  view.value = view.value === "album" ? "table" : "album";
};

const sortColumn = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
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
</script>
```

This setup provides a toggle switch to switch between album view and table view, displaying all tracks in a single table with columns for album art and album name.


For the view toggle use something like this

   <div class="mt-16 flex justify-center">
        <fieldset aria-label="Payment frequency">
          <RadioGroup v-model="frequency" class="grid grid-cols-2 gap-x-1 rounded-full p-1 text-center text-xs font-semibold leading-5 ring-1 ring-inset ring-gray-200">
            <RadioGroupOption as="template" v-for="option in frequencies" :key="option.value" :value="option" v-slot="{ checked }">
              <div :class="[checked ? 'bg-indigo-600 text-white' : 'text-gray-500', 'cursor-pointer rounded-full px-2.5 py-1']">{{ option.label }}</div>
            </RadioGroupOption>
          </RadioGroup>
        </fieldset>
      </div>


To incorporate the provided toggle switch into the `Discography.vue` component, let's make sure to import the necessary elements from the `@headlessui/vue` package and update the component accordingly.

First, install the `@headlessui/vue` package if you haven't already:

```bash
npm install @headlessui/vue
```

Now, update the `Discography.vue` component with the new toggle switch:

```vue
<template>
  <div class="flex-grow flex items-center justify-center">
    <div class="px-4 sm:px-6 lg:px-8 py-12 w-full max-w-7xl mx-auto">
      <header class="sm:flex sm:items-center justify-between">
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

      <div class="mt-16 flex justify-center">
        <fieldset aria-label="View mode">
          <RadioGroup v-model="view" class="grid grid-cols-2 gap-x-1 rounded-full p-1 text-center text-xs font-semibold leading-5 ring-1 ring-inset ring-gray-200">
            <RadioGroupOption as="template" v-for="option in viewOptions" :key="option.value" :value="option.value" v-slot="{ checked }">
              <div :class="[checked ? 'bg-indigo-600 text-white' : 'text-gray-500', 'cursor-pointer rounded-full px-2.5 py-1']">{{ option.label }}</div>
            </RadioGroupOption>
          </RadioGroup>
        </fieldset>
      </div>

      <div v-if="loading" class="mt-2 text-sm text-gray-700">Loading...</div>
      <div v-if="error" class="mt-2 text-sm text-red-700">
        An error occurred while fetching the discography.
      </div>

      <div v-if="!loading && !error" class="mt-8">
        <div v-if="view === 'album'">
          <AlbumView :albums="sortedAlbums" :expanded-album="expandedAlbum" @toggle-album="toggleAlbum" />
        </div>
        <div v-else>
          <TrackTableView :albums="sortedAlbums" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import axios from "axios";
import { RadioGroup, RadioGroupOption } from "@headlessui/vue";
import AlbumView from "@/components/AlbumView.vue";
import TrackTableView from "@/components/TrackTableView.vue";

const loading = ref(true);
const error = ref(false);
const albumList = ref([]);
const sortKey = ref("datePublished");
const sortOrder = ref("desc");
const expandedAlbum = ref(null);
const view = ref("album"); // new state to track the current view

const viewOptions = [
  { value: "album", label: "Album View" },
  { value: "table", label: "Table View" },
];

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
</script>
```

### TrackTableView.vue

Here is the complete `TrackTableView.vue` component:

```vue
<template>
  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-300">
      <thead>
        <tr>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            #
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Art
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Album Name
          </th>
          <th class="sticky top-0 py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 bg-gray-50">
            Name
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Artist
          </th>
          <th class="sticky top-0 hidden sm:table-cell px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Length
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            Release Year
          </th>
          <th class="sticky top-0 px-3 py-3.5 text-right text-sm font-semibold text-gray-900 bg-gray-50">
            <span class="sr-only">Links</span>
          </th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        <tr
          v-for="(song, songIndex) in allTracks"
          :key="song.name"
          class="hover:bg-gray-50"
        >
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ songIndex + 1 }}</td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">
            <nuxt-picture
              :src="song.album.image"
              type="image/webp"
              alt="Album Art"
              width="50"
              height="50"
              class="object-cover"
            />
          </td>
          <td class="py-4 pl-4 pr-3 text-sm text-gray-900">{{ song.album.name }}</td>
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
          <td class="hidden sm:table-cell py-4 px-3 text-sm text-right text-gray-900">
            {{ formatDuration(song.duration) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-900">
            {{ formatYear(song.datePublished) }}
          </td>
          <td class="py-4 px-3 text-sm text-right text-gray-500">
            <TrackLinks :song="song" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed } from "vue";
import TrackLinks from "@/components/TrackLinks.vue";

const props = defineProps({
  albums: Array,
});

const allTracks = computed(() => {
  return props.albums.flatMap((album) =>
    album.track.map((track) => ({ ...track, album }))
  );
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

Make sure the `TrackLinks.vue` component is available and properly displays the links:

```vue
<template>
  <div>
    <a
      :style="{ opacity: song.url ? 1 : 


We need to setup an env for our Spotify access token


To set up an environment for your Spotify access token, you will need to follow these steps:

1. **Create a `.env` file** to store your environment variables.
2. **Set up the environment variables** for your Spotify access token.
3. **Configure your application to use the environment variables.**

### Step 1: Create a `.env` File

Create a `.env` file in the root directory of your project. This file will store your environment variables.

```
SPOTIFY_ACCESS_TOKEN=your_spotify_access_token_here
```

Replace `your_spotify_access_token_here` with your actual Spotify access token.

### Step 2: Configure Your Application to Use Environment Variables

If you're using Vue.js with Vite, you can access environment variables by prefixing them with `VITE_`. Update your `.env` file accordingly:

```
VITE_SPOTIFY_ACCESS_TOKEN=your_spotify_access_token_here
```

### Step 3: Access the Environment Variable in Your Application

You can now access the environment variable in your Vue components or JavaScript files. For example, in a Vue component:

```vue
<script setup>
const spotifyAccessToken = import.meta.env.VITE_SPOTIFY_ACCESS_TOKEN;
console.log(spotifyAccessToken);
</script>
```

Or in a JavaScript file:

```javascript
const spotifyAccessToken = import.meta.env.VITE_SPOTIFY_ACCESS_TOKEN;
console.log(spotifyAccessToken);
```

### Step 4: Use the Access Token in API Requests

When making API requests to Spotify, include the access token in the headers. Here’s an example of how you can do this with Axios:

```javascript
import axios from 'axios';

const spotifyAccessToken = import.meta.env.VITE_SPOTIFY_ACCESS_TOKEN;

const getSpotifyData = async () => {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me', {
      headers: {
        Authorization: `Bearer ${spotifyAccessToken}`,
      },
    });
    console.log(response.data);
  } catch (error) {
    console.error('Error fetching Spotify data', error);
  }
};

getSpotifyData();
```

### Additional Configuration

1. **Install dotenv**: If you're not using Vite, you might need the `dotenv` package to load environment variables from a `.env` file. Install it using npm or yarn:

```bash
npm install dotenv
```

2. **Load the environment variables**: In your application's entry file (e.g., `main.js` or `index.js`), load the environment variables using `dotenv`:

```javascript
require('dotenv').config();
const spotifyAccessToken = process.env.SPOTIFY_ACCESS_TOKEN;
console.log(spotifyAccessToken);
```

### Example in a Vue Component

Here’s a complete example of how you can use the Spotify access token in a Vue component to fetch data from the Spotify API:

```vue
<template>
  <div>
    <h1>Spotify Data</h1>
    <pre>{{ spotifyData }}</pre>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import axios from 'axios';

const spotifyData = ref(null);

const fetchSpotifyData = async () => {
  const spotifyAccessToken = import.meta.env.VITE_SPOTIFY_ACCESS_TOKEN;
  try {
    const response = await axios.get('https://api.spotify.com/v1/me', {
      headers: {
        Authorization: `Bearer ${spotifyAccessToken}`,
      },
    });
    spotifyData.value = response.data;
  } catch (error) {
    console.error('Error fetching Spotify data', error);
  }
};

onMounted(() => {
  fetchSpotifyData();
});
</script>
```

### Security Note

Do not commit your `.env` file to version control. Add `.env` to your `.gitignore` file to ensure it is not included in your repository:

```
# .gitignore

**Related:** [[jovie_music]]

**Related:** [[music_industry]]
.env
```

This setup will securely store your Spotify access token and make it accessible throughout your Vue.js application.


Im using nuxt


When using Nuxt.js, you can set up environment variables specifically for your project by following these steps:

### Step 1: Create a `.env` File

Create a `.env` file in the root directory of your project. This file will store your environment variables.

```env
SPOTIFY_ACCESS_TOKEN=your_spotify_access_token_here
```

Replace `your_spotify_access_token_here` with your actual Spotify access token.

### Step 2: Install `@nuxtjs/dotenv`

Install the `@nuxtjs/dotenv` module to load environment variables from your `.env` file into your Nuxt.js application.

```bash
npm install @nuxtjs/dotenv
```

### Step 3: Configure `@nuxtjs/dotenv` in `nuxt.config.js`

Add `@nuxtjs/dotenv` to the `modules` section of your `nuxt.config.js` file:

```javascript
// nuxt.config.js
export default {
  // Other configurations...
  modules: [
    '@nuxtjs/dotenv',
  ],
  // Optionally, you can specify the path to your .env file
  dotenv: {
    path: process.cwd(), // Default is the project root
  },
}
```

### Step 4: Access the Environment Variable in Your Application

You can access the environment variables in your components or JavaScript files using `process.env`. Here’s an example of how to do this in a Nuxt.js component:

```vue
<template>
  <div>
    <h1>Spotify Data</h1>
    <pre>{{ spotifyData }}</pre>
  </div>
</template>

<script>
export default {
  data() {
    return {
      spotifyData: null,
    };
  },
  async mounted() {
    await this.fetchSpotifyData();
  },
  methods: {
    async fetchSpotifyData() {
      const spotifyAccessToken = process.env.SPOTIFY_ACCESS_TOKEN;
      try {
        const response = await this.$axios.$get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${spotifyAccessToken}`,
          },
        });
        this.spotifyData = response;
      } catch (error) {
        console.error('Error fetching Spotify data', error);
      }
    },
  },
};
</script>
```

### Step 5: Install and Configure `@nuxtjs/axios`

If you haven't already, install `@nuxtjs/axios` to make HTTP requests easier:

```bash
npm install @nuxtjs/axios
```

Add `@nuxtjs/axios` to the `modules` section of your `nuxt.config.js` file:

```javascript
// nuxt.config.js
export default {
  // Other configurations...
  modules: [
    '@nuxtjs/dotenv',
    '@nuxtjs/axios',
  ],
  axios: {
    // Axios module configuration
  },
  dotenv: {
    path: process.cwd(), // Default is the project root
  },
}
```

### Example Component Using Axios

Here’s a full example of a Nuxt.js component that uses the Spotify access token to fetch data from the Spotify API:

```vue
<template>
  <div>
    <h1>Spotify Data</h1>
    <pre>{{ spotifyData }}</pre>
  </div>
</template>

<script>
export default {
  data() {
    return {
      spotifyData: null,
    };
  },
  async mounted() {
    await this.fetchSpotifyData();
  },
  methods: {
    async fetchSpotifyData() {
      const spotifyAccessToken = process.env.SPOTIFY_ACCESS_TOKEN;
      try {
        const response = await this.$axios.$get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${spotifyAccessToken}`,
          },
        });
        this.spotifyData = response;
      } catch (error) {
        console.error('Error fetching Spotify data', error);
      }
    },
  },
};
</script>
```

### Security Note

Do not commit your `.env` file to version control. Add `.env` to your `.gitignore` file to ensure it is not included in your repository:

```gitignore
# .gitignore
.env
```

By following these steps, you will securely store your Spotify access token and make it accessible throughout your Nuxt.js application.


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_music-album-json-update-part1]]
- [[chatgpt/chatgpt_music-album-json-update-part2]]
- [[chatgpt/chatgpt_music-album-json-update-part3]]
- [[chatgpt/chatgpt_music-album-json-update-part4]]
- [[chatgpt/chatgpt_update-json-manifest-version]]
