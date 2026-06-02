
<template>
  <div
    class="relative isolate z-0 mx-auto cursor-pointer items-center hover:opacity-100 dark:text-jovieDark-100"
    :class="[
      { 'saturate-0': color == 'black' },

      { 'opacity-100': !linkDisabled },
      { 'opacity-10': linkDisabled },

      { 'group-hover:opacity-100': groupHover },
    ]"
  >
    <a class="" :href="link" target="blank">
      <svg
        v-if="icon == 'linkedin'"
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto ' : 'mx-auto '"
      >
        <title>LinkedIn</title>
        <path
          fill="#0077b5"
          d="M20.447
          20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136
          1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85
          3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144
          0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925
          2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782
          13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0
          1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24
          22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
        />
      </svg>
      <svg
        v-if="icon == 'twitter'"
        role="img"
        color="currentColor"
        viewBox="0 0 24 24"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto  ' : 'mx-auto'"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Twitter</title>
        <path
          fill="#1da1f2"
          d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"
        />
      </svg>
      <svg
        v-if="icon == 'instagram'"
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto  ' : 'mx-auto'"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Instagram</title>
        <path
          fill="#e1306c"
          d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"
        />
      </svg>
      <svg
        v-if="icon == 'youtube'"
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto  ' : 'mx-auto'"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>YouTube</title>
        <path
          fill="#FF0000"
          d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
        />
      </svg>
      <svg
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto  ' : 'mx-auto'"
        v-if="icon == 'snapchat'"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Snapchat</title>
        <path
          fill="#fffc00"
          d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z"
        />
      </svg>
      <svg
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        :height="height"
        :weight="width"
        :class="iconstyle == 'horizontal' ? 'z-0 mx-auto  ' : 'mx-auto'"
        v-if="icon == 'tiktok'"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>TikTok</title>
        <path
          fill="currentColor"
          d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
        />
      </svg>
      <svg
        role="img"
        viewBox="0 0 24 24"
        color="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        :height="height"
        :weight="width"
        :class="
          iconstyle == 'horizontal'
            ? 'z-0 mx-auto  '
            : 'mx-auto  text-slate-400 dark:text-jovieDark-600'
        "
        v-if="icon == 'twitch'"
      >
        <title>Twitch</title>

        <path
          fill="#6441a5"
          d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"
        />
      </svg>
    </a>
    <div
      class="text-center text-2xs text-slate-500 dark:text-jovieDark-300"
      v-if="countsVisible"
    >
      {{ followers || "" }}
    </div>
  </div>
</template>
<script>
export default {
  props: {
    color: {
      type: String,
      default: "black",
    },
    height: {
      type: String,
      default: "5px",
    },
    width: {
      type: String,
      default: "auto",
    },
    countsVisible: {
      type: Boolean,
      default: false,
    },
    icon: {
      type: String,
      default: "twitter",
    },
    iconstyle: {
      type: String,
      default: "horizontal",
    },
    link: {
      type: String,

      default: "",
    },
    followers: {
      type: String,
    },
    linkDisabled: {
      type: Boolean,
      default: false,
    },
    groupHover: {
      type: Boolean,
      default: false,
    },
  },
};
</script>
we will use icons in the /icons folder instead they will all be svg files


To use the new `Button` component for social icons and to ensure that the icons are sourced from the `/icons` folder, here is how you can refactor the profile page and the SocialIcons component accordingly:

### SocialIcons.vue
First, we create a `SocialIcons.vue` component that dynamically imports the SVG icons based on the provided `icon` prop:

```vue
<template>
  <component
    :is="iconComponent"
    role="img"
    :class="['icon', iconClass]"
    :style="{ width: width, height: height }"
  ></component>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  icon: {
    type: String,
    required: true,
  },
  height: {
    type: String,
    default: '24px',
  },
  width: {
    type: String,
    default: '24px',
  },
  iconstyle: {
    type: String,
    default: 'horizontal',
  },
});

const iconClass = computed(() => {
  return props.iconstyle === 'horizontal' ? 'z-0 mx-auto' : 'mx-auto';
});

const iconComponent = computed(() => {
  try {
    return defineAsyncComponent(() => import(`@/icons/${props.icon}.svg`));
  } catch (e) {
    console.error(`Icon not found: ${props.icon}`);
    return null;
  }
});
</script>

<style scoped>
.icon {
  fill: currentColor;
}
</style>
```

### Profile.vue
Next, we use the `Button` component for the social icons and the subscribe button:

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

### Note:
- Ensure the SVG files for the icons are placed in the `/icons` directory and named accordingly (e.g., `youtube.svg`, `tiktok.svg`).
- Adjust paths as needed based on your project structure. 

This refactored code makes use of the `Button` component for both the social icon buttons and the subscribe button, improving reusability and maintainability.


{'asset_pointer': 'file-service://file-iM3LbcKwwJpsIhvgDqpc7DCq', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 634, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 217909, 'width': 1536}


The error indicates that the async component loading for the SVG files is failing. Instead of loading SVG files dynamically using `defineAsyncComponent`, let's try a different approach to import the SVG icons.

### SocialIcons.vue

Refactor the `SocialIcons.vue` to directly import the SVG files:

```vue
<template>
  <component
    :is="iconComponent"
    role="img"
    :class="['icon', iconClass]"
    :style="{ width: width, height: height }"
  ></component>
</template>

<script setup>
import { computed } from 'vue';
import { useHeadlessUI } from '@headlessui/vue';

const props = defineProps({
  icon: {
    type: String,
    required: true,
  },
  height: {
    type: String,
    default: '24px',
  },
  width: {
    type: String,
    default: '24px',
  },
  iconstyle: {
    type: String,
    default: 'horizontal',
  },
});

const iconClass = computed(() => {
  return props.iconstyle === 'horizontal' ? 'z-0 mx-auto' : 'mx-auto';
});

const iconComponent = computed(() => {
  const icons = {
    youtube: () => import('@/icons/youtube.svg'),
    tiktok: () => import('@/icons/tiktok.svg'),
    twitter: () => import('@/icons/twitter.svg'),
    instagram: () => import('@/icons/instagram.svg'),
    facebook: () => import('@/icons/facebook.svg'),
    linkedin: () => import('@/icons/linkedin.svg'),
    snapchat: () => import('@/icons/snapchat.svg'),
    twitch: () => import('@/icons/twitch.svg'),
  };

  return icons[props.icon] || null;
});
</script>

<style scoped>
.icon {
  fill: currentColor;
}
</style>
```

Ensure that the SVG files are located in the `@/icons` directory as expected.

### Profile.vue

Here's the `Profile.vue` with the `Button` component and `SocialIcons` component properly integrated:

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

### Notes:
- The `SocialIcons.vue` now imports the SVG icons directly using the computed property `iconComponent`.
- The `Profile.vue` page uses the `Button` component for rendering social links


{'asset_pointer': 'file-service://file-hhBHbWFViTIMCVzF7zMNAdqp', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 644, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 291024, 'width': 1536}
the icons exist in public/icons/


To resolve the issue of dynamically importing SVG files from the `public/icons` directory, you should refer to the `public` directory directly in your imports. However, dynamic imports are generally meant for JavaScript modules, not static assets like SVGs in the `public` folder. Instead, you can directly reference the SVG files with their URLs.

Here’s how to update the `SocialIcons.vue` to use SVGs directly from the `public/icons` folder:

### SocialIcons.vue

Update the component to reference the SVG files directly:

```vue
<template>
  <div :class="iconClass" role="img" :style="{ width: width, height: height }">
    <img :src="iconUrl" :alt="`${icon} icon`" />
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  icon: {
    type: String,
    required: true,
  },
  height: {
    type: String,
    default: '24px',
  },
  width: {
    type: String,
    default: '24px',
  },
  iconstyle: {
    type: String,
    default: 'horizontal',
  },
});

const iconClass = computed(() => {
  return props.iconstyle === 'horizontal' ? 'z-0 mx-auto' : 'mx-auto';
});

const iconUrl = computed(() => {
  return `/icons/${props.icon}.svg`;
});
</script>

<style scoped>
.icon {
  fill: currentColor;
}
</style>
```

### Profile.vue

No changes are needed here if you have already correctly imported and used the `Button` and `SocialIcons` components.

Ensure your directory structure is correct and that the SVG files are indeed located in the `public/icons` directory. Here's a sample directory structure:

```
project-root/
  public/
    icons/
      youtube.svg
      tiktok.svg
      twitter.svg
      instagram.svg
      facebook.svg
      linkedin.svg
      snapchat.svg
      twitch.svg
  src/
    components/
      SocialIcons.vue
      Button.vue
      Profile.vue
```

### Notes:
- This approach directly uses the SVG files from the `public` folder by specifying the URL.
- Ensure the SVG filenames match exactly with the values used in the `icon` prop.

This should resolve the `500` error related to dynamic imports and correctly display the SVG icons.


the image on the contact avatar is not round because we are not making it square before we round it.

<template>
  <span
    :class="[
      className,
      'inline-grid shrink-0 align-middle',
      square
        ? 'rounded-[--avatar-radius] *:rounded-[--avatar-radius]'
        : 'rounded-full *:rounded-full',
      'outline outline-1 -outline-offset-1 outline-black/[--ring-opacity] dark:outline-white/[--ring-opacity]',
    ]"
    data-slot="avatar"
    v-bind="$attrs"
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
    <img v-if="src" :src="src" :alt="alt" class="size-full" />
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
  },
};
</script>

<style scoped>
.size-full {
  width: 100%;
  height: 100%;
}
</style>


To ensure the avatar image is round, you need to make sure the height and width are the same before applying the `rounded-full` class. Here’s how you can adjust your `ContactAvatar.vue` component to handle this correctly:

### ContactAvatar.vue

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
    <img v-if="src" :src="src" :alt="alt" class="size-full" />
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

### Profile.vue

Ensure you are passing a size prop to make sure the avatar is displayed correctly:

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
          :size="'64px'" // or any size you prefer
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
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified


{'asset_pointer': 'file-service://file-d3XOkPlqsK5jGkTXpkRExKC6', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 642, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 239159, 'width': 1536}
if i add an aspect square it make its a circle but its stretched.

<template>
  <span
    :class="[
      className,
      'inline-grid shrink-0 align-middle',
      square
        ? 'rounded-[--avatar-radius] *:rounded-[--avatar-radius]'
        : 'rounded-full *:rounded-full',
      'outline outline-1 -outline-offset-1 outline-black/[--ring-opacity] dark:outline-white/[--ring-opacity]',
    ]"
    data-slot="avatar"
    v-bind="$attrs"
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
    <img v-if="src" :src="src" :alt="alt" class="size-full aspect-square" />
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
  },
};
</script>

<style scoped>
.size-full {
  width: 100%;
  height: 100%;
}
</style>
