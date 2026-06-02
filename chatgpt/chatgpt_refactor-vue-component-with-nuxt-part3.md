
To fix the stretching issue and ensure the avatar image is a perfect circle, you need to make sure that both the width and height are the same and maintain the aspect ratio correctly. Using `aspect-square` class should help, but let's ensure the parent span element is properly squared.

Here’s how you can adjust your `ContactAvatar.vue` component:

### ContactAvatar.vue

```vue
<template>
  <span
    :class="[
      className,
      'inline-grid shrink-0 align-middle relative',
      square ? 'rounded-[--avatar-radius] *:rounded-[--avatar-radius]' : 'rounded-full *:rounded-full',
      'outline outline-1 -outline-offset-1 outline-black/[--ring-opacity] dark:outline-white/[--ring-opacity]',
    ]"
    data-slot="avatar"
    v-bind="$attrs"
    :style="avatarStyle"
  >
    <svg
      v-if="initials"
      class="size-full select-none fill-current p-[5%] text-[48px] font-medium uppercase"
      viewBox="0 0 100 100"
      :aria-hidden="alt ? undefined : 'true'"
    >
      <title v-if="alt">{{ alt }}</title>
      <text
        x="50%"
        y="50%"
        alignment-baseline="middle"
        dominant-baseline="middle"
        text-anchor="middle"
        dy=".125em"
      >
        {{ initials }}
      </text>
    </svg>
    <img v-if="src" :src="src" :alt="alt" class="w-full h-full object-cover rounded-full" />
  </span>
</template>

<script>
export default {
  name: "ContactAvatar",
  props: {
    src: {
      type: String,
      default: null,
    },
    square: {
      type: Boolean,
      default: false,
    },
    initials: {
      type: String,
      required: false,
    },
    alt: {
      type: String,
      default: "",
    },
    className: {
      type: String,
      default: "",
    },
    size: {
      type: String,
      default: "64px", // Default size
    },
  },
  computed: {
    avatarStyle() {
      return {
        width: this.size,
        height: this.size,
      };
    },
  },
};
</script>

<style scoped>
.size-full {
  width: 100%;
  height: 100%;
}
</style>
```

### Explanation:
1. **`avatarStyle` computed property**: This ensures the `span` element is perfectly square based on the provided size.
2. **`w-full h-full object-cover` on `img`**: These classes ensure the image fills the container while maintaining its aspect ratio and applying `rounded-full` to make it a circle.
3. **`relative` class on `span`**: This ensures proper alignment and positioning within the container.

### Profile.vue

Ensure you are passing a size prop to the `ContactAvatar` component to make sure the avatar is displayed correctly:

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="h-64 w-64"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          Founder at
          <a
            href="#"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
            >Jovie</a
          >
        </p>
        <div class="mt-4 flex justify-center space-x-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </Button>
        </div>
        <Button class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">
          Subscribe
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
      </div>

      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div v-if="creator.songs.length > 0" class="text-center">
          <h2 class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
            Songs
          </h2>
          <ul>
            <li v-for="song in creator.songs" :key="song.slug">
              <NuxtLink :to="`/${creatorName.toLowerCase()}/${song.slug}`">{{
                song.title
              }}</NuxtLink>
            </li>
          </ul>
        </div>
        <div v-else class="text-center">
          <p>No songs available for this creator.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {


{'asset_pointer': 'file-service://file-7WzCOFjpocDiQOuFDH5jmvEi', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 639, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 223665, 'width': 1536}


From the image, it looks like the avatar is not maintaining its size properly. To fix the issue and ensure the avatar image is displayed as a circle without being stretched, we'll make sure that the parent element is correctly squared and the image inside maintains its aspect ratio.

### Updated ContactAvatar.vue

Here’s how to adjust your `ContactAvatar.vue` to ensure the image is displayed correctly:

```vue
<template>
  <span
    :class="[
      className,
      'inline-grid shrink-0 align-middle',
      square ? 'rounded-[--avatar-radius] *:rounded-[--avatar-radius]' : 'rounded-full *:rounded-full',
      'outline outline-1 -outline-offset-1 outline-black/[--ring-opacity] dark:outline-white/[--ring-opacity]',
    ]"
    data-slot="avatar"
    v-bind="$attrs"
    :style="avatarStyle"
  >
    <svg
      v-if="initials"
      class="size-full select-none fill-current p-[5%] text-[48px] font-medium uppercase"
      viewBox="0 0 100 100"
      :aria-hidden="alt ? undefined : 'true'"
    >
      <title v-if="alt">{{ alt }}</title>
      <text
        x="50%"
        y="50%"
        alignment-baseline="middle"
        dominant-baseline="middle"
        text-anchor="middle"
        dy=".125em"
      >
        {{ initials }}
      </text>
    </svg>
    <img v-if="src" :src="src" :alt="alt" class="w-full h-full object-cover" />
  </span>
</template>

<script>
export default {
  name: "ContactAvatar",
  props: {
    src: {
      type: String,
      default: null,
    },
    square: {
      type: Boolean,
      default: false,
    },
    initials: {
      type: String,
      required: false,
    },
    alt: {
      type: String,
      default: "",
    },
    className: {
      type: String,
      default: "",
    },
    size: {
      type: String,
      default: "128px", // Default size
    },
  },
  computed: {
    avatarStyle() {
      return {
        width: this.size,
        height: this.size,
      };
    },
  },
};
</script>

<style scoped>
.size-full {
  width: 100%;
  height: 100%;
}
</style>
```

### Profile.vue

Ensure you are passing the `size` prop to the `ContactAvatar` component to make sure the avatar is displayed correctly:

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="h-32 w-32"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          Founder at
          <a
            href="#"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
            >Jovie</a
          >
        </p>
        <div class="mt-4 flex justify-center space-x-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </Button>
        </div>
        <Button class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">
          Subscribe
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
      </div>

      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div v-if="creator.songs.length > 0" class="text-center">
          <h2 class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
            Songs
          </h2>
          <ul>
            <li v-for="song in creator.songs" :key="song.slug">
              <NuxtLink :to="`/${creatorName.toLowerCase()}/${song.slug}`">{{
                song.title
              }}</NuxtLink>
            </li>
          </ul>
        </div>
        <div v-else class="text-center">
          <p>No songs available for this creator.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";
import ContactAvatar from "@/components/ContactAvatar.vue";
import SocialIcons from "@/components/SocialIcons.vue";
import Button from "@/components/Button.vue"; // Import Button component

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    isVerified: true,
    profile_pic_url: "/img/LA_based_singer_tim_white.jpg",
    initials: "TW",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    socialLinks: [
      { network: "youtube", url: "https://youtube.com/timwhite" },
      { network: "tiktok", url: "https://tiktok.com/@timwhite" },
      { network: "twitter", url: "https://twitter.com/timwhite" },
      { network: "facebook", url: "https://facebook.com/timwhite" },
      { network: "instagram", url: "https://instagram.com/timwhite" },
      { network: "spotify", url: "https://spotify.com/timwhite" },
      { network: "apple", url: "https://apple.com/timwhite" },
    ],
    songs: [
      {
        title: "Never Say A Word",
        slug: "nsaw",
      },
    ],
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https


remove songs from the profile page for now.

use the button component for each of the social links and have them link to the urls of the creators profiles. display a max of 3 buttons per row. give the buttons a border


Here's the updated `Profile.vue` file to remove the songs section and display a maximum of three social link buttons per row using the `Button` component with a border.

### Updated Profile.vue

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="h-32 w-32"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          Founder at
          <a
            href="#"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
            >Jovie</a
          >
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </Button>
        </div>
        <Button class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">
          Subscribe
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";
import ContactAvatar from "@/components/ContactAvatar.vue";
import SocialIcons from "@/components/SocialIcons.vue";
import Button from "@/components/Button.vue"; // Import Button component

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    isVerified: true,
    profile_pic_url: "/img/LA_based_singer_tim_white.jpg",
    initials: "TW",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    socialLinks: [
      { network: "youtube", url: "https://youtube.com/timwhite" },
      { network: "tiktok", url: "https://tiktok.com/@timwhite" },
      { network: "twitter", url: "https://twitter.com/timwhite" },
      { network: "facebook", url: "https://facebook.com/timwhite" },
      { network: "instagram", url: "https://instagram.com/timwhite" },
      { network: "spotify", url: "https://spotify.com/timwhite" },
      { network: "apple", url: "https://apple.com/timwhite" },
    ],
    songs: [],
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified: false,
  profile_pic_url: "",
  initials: "",
  bio: "",
  socialLinks: [],
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **Grid Layout for Buttons**: The buttons are placed inside a grid layout using `grid-cols-3` to ensure a maximum of three buttons per row.
2. **Button Component with Border**: The `Button` component for each social link includes a border class (`border border-gray-300 dark:border-gray-700`).

This setup should ensure that the buttons are displayed correctly with a border and a maximum of three per row.


make the "founder at jovie" dynmixa for the users bio


To make the "Founder at Jovie" dynamic for each user's bio, you can adjust the `Profile.vue` to include this information as part of the `creator` object. Here’s how you can adjust your code to make the "Founder at Jovie" dynamic:

### Updated Profile.vue

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="h-32 w-32"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          {{ creator.role }} at
          <a
            :href="creator.organizationUrl"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
            >{{ creator.organization }}</a
          >
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </Button>
        </div>
        <Button class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">
          Subscribe
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";
import ContactAvatar from "@/components/ContactAvatar.vue";
import SocialIcons from "@/components/SocialIcons.vue";
import Button from "@/components/Button.vue"; // Import Button component

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    isVerified: true,
    profile_pic_url: "/img/LA_based_singer_tim_white.jpg",
    initials: "TW",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    role: "Founder",
    organization: "Jovie",
    organizationUrl: "#", // Replace with actual URL
    socialLinks: [
      { network: "youtube", url: "https://youtube.com/timwhite" },
      { network: "tiktok", url: "https://tiktok.com/@timwhite" },
      { network: "twitter", url: "https://twitter.com/timwhite" },
      { network: "facebook", url: "https://facebook.com/timwhite" },
      { network: "instagram", url: "https://instagram.com/timwhite" },
      { network: "spotify", url: "https://spotify.com/timwhite" },
      { network: "apple", url: "https://apple.com/timwhite" },
    ],
    songs: [],
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    role: "Co-Founder",
    organization: "MusicWorld",
    organizationUrl: "#", // Replace with actual URL
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified: false,
  profile_pic_url: "",
  initials: "",
  bio: "",
  role: "",
  organization: "",
  organizationUrl: "",
  socialLinks: [],
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **Dynamic Role and Organization**: Added `role`, `organization`, and `organizationUrl` properties to the `creator` object to make the "Founder at Jovie" part dynamic.
2. **Profile.vue**: Updated the profile section to use these properties.

Now, the role and organization will dynamically change based on the `creator` object data.


the profile will have a call to action button. the button type can be Listen, or watch. if listen the bitton text says listen now and if watch the button text says watch now. for the example suer tim we will have it be listen and the button link will be to spotify.


To add a dynamic call-to-action button based on the type (Listen or Watch), we can add a `cta` property to the `creator` object. This property will include the type (Listen or Watch) and the corresponding URL.

Here’s how you can update the `Profile.vue` to include this functionality:

### Updated Profile.vue

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="h-32 w-32"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          {{ creator.role }} at
          <a
            :href="creator.organizationUrl"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
            >{{ creator.organization }}</a
          >
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </Button>
        </div>
        <Button
          v-if="creator.cta"
          :href="creator.cta.url"
          class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700"
        >
          {{ creator.cta.type === 'listen' ? 'Listen Now' : 'Watch Now' }}
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";
import ContactAvatar from "@/components/ContactAvatar.vue";
import SocialIcons from "@/components/SocialIcons.vue";
import Button from "@/components/Button.vue"; // Import Button component

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    isVerified: true,
    profile_pic_url: "/img/LA_based_singer_tim_white.jpg",
    initials: "TW",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    role: "Founder",
    organization: "Jovie",
    organizationUrl: "#", // Replace with actual URL
    socialLinks: [
      { network: "youtube", url: "https://youtube.com/timwhite" },
      { network: "tiktok", url: "https://tiktok.com/@timwhite" },
      { network: "twitter", url: "https://twitter.com/timwhite" },
      { network: "facebook", url: "https://facebook.com/timwhite" },
      { network: "instagram", url: "https://instagram.com/timwhite" },
      { network: "spotify", url: "https://spotify.com/timwhite" },
      { network: "apple", url: "https://apple.com/timwhite" },
    ],
    cta: {
      type: "listen",
      url: "https://spotify.com/timwhite",
    },
    songs: [],
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    role: "Co-Founder",
    organization: "MusicWorld",
    organizationUrl: "#", // Replace with actual URL
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    cta: {
      type: "watch",
      url: "https://youtube.com/kenzie",
    },
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified: false,
  profile_pic_url: "",
  initials: "",
  bio: "",
  role: "",
  organization: "",
  organizationUrl: "",
  socialLinks: [],
  cta: null,
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **Dynamic CTA Button**: Added a `cta` property to the `creator` object, which includes `type` and `url`.
2. **Profile.vue**: Updated the template to include a button that changes text based on the `cta.type` (Listen or Watch) and links to the `cta.url`.
3. **Button Display**: The CTA button will only display if the `cta` property is present.

This will ensure the CTA button displays the correct text and links to the appropriate URL based on the creator's profile data.


<template>
  <span
    :class="[
      className,
      'inline-grid shrink-0 align-middle',
      square
        ? 'rounded-[--avatar-radius] *:rounded-[--avatar-radius]'
        : ' rounded-full *:rounded-full',
      'outline outline-1 -outline-offset-1 outline-black/[--ring-opacity] dark:outline-white/[--ring-opacity]',
    ]"
    data-slot="avatar"
    v-bind="$attrs"
    :style="avatarStyle"
  >
    <svg
      v-if="initials"
      class="size-full select-none fill-current p-[5%] text-[48px] font-medium uppercase"
      viewBox="0 0 100 100"
      :aria-hidden="alt ? undefined : 'true'"
    >
      <title v-if="alt">{{ alt }}</title>
      <text
        x="50%"
        y="50%"
        alignment-baseline="middle"
        dominant-baseline="middle"
        text-anchor="middle"
        dy=".125em"
      >
        {{ initials }}
      </text>
    </svg>
    <img v-if="src" :src="src" :alt="alt" class="w-full h-full object-cover" />
  </span>
</template>

<script>
export default {
  name: "ContactAvatar",
  props: {
    src: {
      type: String,
      default: null,
    },
    square: {
      type: Boolean,
      default: false,
    },
    initials: {
      type: String,
      required: false,
    },
    alt: {
      type: String,
      default: "",
    },
    className: {
      type: String,
      default: "",
    },
    size: {
      type: String,
      default: "128px", // Default size
    },
  },
  computed: {
    avatarStyle() {
      return {
        width: this.size,
        height: this.size,
      };
    },
  },
};
</script>

<style scoped>
.size-full {
  width: 100%;
  height: 100%;
}
</style>
 How do i put this in my parent component and have it have a border raidus of 2 and a ring color of white


To add a border radius of 2 and a ring color of white to the `ContactAvatar` component from the parent component, you can pass additional classes via the `className` prop. You can use Tailwind CSS classes to achieve this.

Here’s how you can adjust the parent component to apply these styles:

### Parent Component (Profile.vue or any other parent component)

```vue
<template>
  <div
    v-if="creator"
    class="flex items-center justify-center min-h-screen bg-slate-50 px-4 dark:bg-jovieDark-900 sm:px-6 lg:px-8"
  >
    <div class="max-w-md space-y-8 text-center">
      <div>
        <ContactAvatar
          :src="creator.profile_pic_url"
          :initials="creator.initials"
          :alt="creator.name + ' Profile Picture'"
          :size="'128px'" // Adjust size as needed
          class="border border-gray-300 dark:border-gray-700 ring-2 ring-white"
        />
        <div class="flex items-center justify-center mt-6">
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ creator.name }}
          </h2>
          <svg
            v-if="creator.isVerified"
            xmlns="http://www.w3.org/2000/svg"
            class="ml-2 h-6 w-6 text-indigo-600 dark:text-indigo-300"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg


i mean ring-2 not border radisu


**Topic:** [[chatgpt-clusters/coding_web_dev]]
