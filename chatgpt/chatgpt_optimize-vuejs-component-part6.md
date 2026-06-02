
Here's the parent component that utilizes the `ContactAvatar` and `ContactAvatarButton` components:

### ParentComponent.vue

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
          <h2 class="text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">{{ creator.name }}</h2>
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
          <a href="#" class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400">Jovie</a>
        </p>
        <div class="mt-4 flex justify-center space-x-4">
          <a
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            target="_blank"
            class="text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="24px" width="24px" />
          </a>
        </div>
        <button class="mt-4 px-8 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">
          Subscribe
        </button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">{{ creator.bio }}</p>
      </div>

      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div v-if="creator.songs.length > 0" class="text-center">
          <h2 class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">Songs</h2>
          <ul>
            <li v-for="song in creator.songs" :key="song.slug">
              <NuxtLink :to="`/${creatorName.toLowerCase()}/${song.slug}`">{{ song.title }}</NuxtLink>
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
import { useRoute } from 'vue-router';
import ContactAvatar from '@/components/ContactAvatar.vue';
import SocialIcons from '@/components/SocialIcons.vue';

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: 'Tim White',
    isVerified: true,
    profile_pic_url: '/img/LA_based_singer_tim_white.jpg',
    initials: 'TW',
    bio: 'Tim White is a musician and songwriter known for his unique sound and captivating lyrics.',
    socialLinks: [
      { network: 'youtube', url: 'https://youtube.com/timwhite' },
      { network: 'tiktok', url: 'https://tiktok.com/@timwhite' },
      { network: 'twitter', url: 'https://twitter.com/timwhite' },
      { network: 'facebook', url: 'https://facebook.com/timwhite' },
      { network: 'instagram', url: 'https://instagram.com/timwhite' },
      { network: 'spotify', url: 'https://spotify.com/timwhite' },
      { network: 'apple', url: 'https://apple.com/timwhite' },
    ],
    songs: [
      {
        title: 'Never Say A Word',
        slug: 'nsaw',
      },
    ],
  },
  kenzie: {
    name: 'Kenzie',
    isVerified: false,
    profile_pic_url: '/path/to/kenzie-pic.jpg',
    initials: 'K',
    bio: 'Kenzie is an upcoming artist with a fresh sound and a growing fan base.',
    socialLinks: [
      { network: 'twitter', url: 'https://twitter.com/kenzie' },
      { network: 'instagram', url: 'https://instagram.com/kenzie' },
      { network: 'facebook', url: 'https://facebook.com/kenzie' },
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: 'Creator not found',
  isVerified: false,
  profile_pic_url: '',
  initials: '',
  bio: '',
  socialLinks: [],
  songs: [],
};

definePageMeta({
  layout: 'links',
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

This parent component includes the `ContactAvatar` component for displaying the creator's avatar and the `SocialIcons` component for displaying social media links. The component also displays the creator's name, verification badge, bio, and songs list.
