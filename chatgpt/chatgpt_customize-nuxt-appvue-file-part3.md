
Sure, we can set the initials to be the song title in case the album art is not available. I'll update the code to ensure that happens.

### Updated Song Page Code

```vue
<template>
  <div
    class="flex items-start py-8 sm:py-12 justify-center h-full bg-slate-50 dark:bg-jovieDark-900 px-4 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="songData.albumArt"
          :initials="getInitials(songData.songTitle)"
          :alt="songData.songTitle + ' Album Art'"
          sizeClasses="w-64 h-64 sm:w-96 sm:h-96"
          class="ring-2 ring-white"
        />
        <div class="flex items-center justify-center mt-6">
          <h2
            class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100"
          >
            {{ songData.songTitle }}
          </h2>
        </div>
        <p
          class="mt-1 text-sm font-semibold text-slate-600 dark:text-jovieDark-300"
        >
          {{ songData.description }}
        </p>
        <div class="grid grid-cols-1 gap-4 mt-4">
          <Button
            v-for="(service, index) in filteredServices"
            :key="service.name"
            :href="service.url"
            customClass="w-full px-8 py-3 bg-white text-slate-800 dark:bg-gray-800 dark:text-white font-semibold rounded-md hover:text-white hover:bg-indigo-700 flex items-center justify-center border border-gray-300 dark:border-gray-700"
          >
            <img
              :src="getIconPath(service.icon)"
              :alt="service.name"
              class="h-6 w-6 mr-2"
            />
            {{ service.name }}
          </Button>
        </div>
        <Button
          v-if="selectedService"
          :href="selectedService.url"
          customClass="mt-4 w-full px-8 py-3 bg-indigo-500 text-slate-800 dark:text-white font-semibold rounded-md hover:text-white hover:bg-indigo-700 flex items-center justify-center"
        >
          Listen Now
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useSeoMeta } from "#app";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import ContactAvatar from "@/components/ContactAvatar.vue";
import Button from "@/components/Button.vue";

dayjs.extend(relativeTime);

const route = useRoute();
const songData = ref({});
const selectedService = ref({});
const creatorName = ref("");
const isFutureRelease = ref(false);
const countdown = ref("");

const iconMap = {
  Spotify: "spotify",
  "Apple Music": "applemusic",
  "YouTube Music": "youtubemusic",
  Pandora: "pandora",
  Audius: "audius",
  iHeartRadio: "iheartradio",
  "Amazon Music": "amazonmusic",
  Soundcloud: "soundcloud",
};

const getIconPath = (icon) => {
  return `/icons/${icon}` || "";
};

// Get initials from song title
const getInitials = (title) => {
  return title
    .split(" ")
    .map(word => word[0])
    .join("")
    .toUpperCase();
};

// Filter services that have a URL
const filteredServices = computed(() => {
  return songData.value.services
    ? songData.value.services.filter((service) => service.url)
    : [];
});

onMounted(async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  const creator = data[route.params.creatorName] || {};
  creatorName.value = creator.name;
  songData.value = creator.songs[route.params.songSlug] || {};
  selectedService.value = filteredServices.value[0] || {};

  if (songData.value.releaseDate) {
    const releaseDate = dayjs(songData.value.releaseDate);
    const now = dayjs();
    if (releaseDate.isAfter(now)) {
      isFutureRelease.value = true;
      countdown.value = releaseDate.fromNow();
    }
  }

  // Set page title and description
  useSeoMeta({
    title: `${creatorName.value} - ${songData.value.songTitle}`,
    description: songData.value.description,
  });
});

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Ensure album art is square */
.contact-avatar img {
  object-fit: cover;
}
</style>
```

### Explanation:

1. **ContactAvatar Component:**
   - The `initials` prop is now set to the initials derived from the song title using the `getInitials` function.
   - This ensures that if the album art is not available, the initials derived from the song title will be displayed.

2. **Button Component:**
   - The `Button` component is reused to create buttons for each music streaming service with an icon and text.

3. **Updated Song Page:**
   - The `getInitials` function is used to derive initials from the song title.
   - The album art is displayed squarely, and the streaming service buttons are styled consistently.

By following these steps, the song page now correctly displays the album art, or the initials of the song title if the album art is not available, along with the music streaming service links in a consistent and user-friendly design.
