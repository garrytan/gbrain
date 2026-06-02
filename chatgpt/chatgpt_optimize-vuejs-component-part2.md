
Here's a revised version of your component using Nuxt's `<nuxt-picture>` and the Composition API:

1. **Use the Composition API**: This will help to organize the code better.
2. **Use `<nuxt-picture>`**: This helps with performance improvements and better image handling.

```vue
<template>
  <div :class="'h-' + height + ' w-' + height + ' relative flex-shrink-0'">
    <span
      :class="[
        loading ? 'animate-pulse' : '',
        height < 24 ? 'ring-2' : 'ring-4',
        loading ? 'bg-slate-200 dark:bg-jovieDark-500' : '',
        contact.color
          ? `ring-${contact.color}-300 dark:ring-${contact.color}-500`
          : 'ring-slate-100 dark:ring-slate-500',
      ]"
      class="group inline-flex h-full w-full items-center justify-center rounded-full bg-slate-300 dark:bg-jovieDark-600"
    >
      <span
        :class="[
          height < 6
            ? 'text-[6px]'
            : height < 8
              ? 'text-2xs'
              : height < 12
                ? 'text-xs'
                : height < 16
                  ? 'text-base'
                  : height < 24
                    ? 'text-lg'
                    : height < 32
                      ? 'text-3xl'
                      : height < 40
                        ? 'text-3xl'
                        : height < 48
                          ? 'text-5xl'
                          : 'text-[8px]',
        ]"
        class="relative inline-block"
      >
        <span
          v-if="updating"
          class="font-medium capitalize leading-none text-white"
        >
          {{ uploadProgress }}%
        </span>
        <nuxt-picture
          v-else-if="hasProfilePic"
          :src="contact.profile_pic_url"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-else-if="contact.full_name || contact.first_name"
          class="font-medium capitalize leading-none text-white"
        >
          {{ initials }}
        </span>
        <nuxt-picture
          v-else
          :src="defaultImage"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-if="editable"
          class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block"
        >
          <label :for="`profile_pic_url_${contact.id}`">
            <PencilIcon class="mx-auto h-1/3 w-1/3 text-white/50 dark:text-jovieDark-300/50" />
            <input
              :disabled="updating || !editable"
              type="file"
              @change="fileChanged"
              :id="`profile_pic_url_${contact.id}`"
              style="display: none"
            />
          </label>
        </span>
      </span>
    </span>
  </div>
</template>

<script>
import { ref, computed, defineComponent } from 'vue';
import { PencilIcon } from '@heroicons/vue/24/solid';
import Vapor from 'vapor-js'; // Ensure to import Vapor correctly

export default defineComponent({
  name: 'ContactAvatar',
  components: { PencilIcon },
  props: {
    contact: { type: Object, required: true },
    editable: { type: Boolean, default: false },
    height: { type: Number, default: 8 },
  },
  setup(props, { emit }) {
    const defaultImage = ref('/defaultAvatar.svg');
    const updating = ref(false);
    const imageLoadError = ref(false);
    const uploadProgress = ref(0);

    const hasProfilePic = computed(() => {
      return props.contact.profile_pic_url && !imageLoadError.value;
    });

    const initials = computed(() => {
      if (props.contact.full_name) {
        return props.contact.full_name
          .split(' ')
          .map(n => n[0])
          .slice(0, 2)
          .join('');
      }
      const firstInitial = props.contact.first_name?.[0] ?? '';
      const lastInitial = props.contact.last_name?.[0] ?? '';
      return firstInitial + lastInitial;
    });

    const loading = computed(() => {
      return props.contact.id == null;
    });

    const fileChanged = (e) => {
      if (!props.editable) return;
      const file = e.target.files[0];
      if (file) {
        uploadProgress.value = 0;
        const src = URL.createObjectURL(file);
        Vapor.store(file, {
          visibility: 'public-read',
          progress: (progress) => {
            uploadProgress.value = Math.round(progress * 100);
          },
        }).then((response) => {
          if (response.uuid) {
            emit('updateAvatar', response.uuid);
            requestAnimationFrame(() => {
              document.getElementById(`profile_pic_url_img_${props.contact.id}`).src = src;
            });
          }
        });
      }
    };

    return {
      defaultImage,
      updating,
      imageLoadError,
      uploadProgress,
      hasProfilePic,
      initials,
      loading,
      fileChanged,
    };
  },
});
</script>
```

### Summary of Changes:
1. **Composition API**: Used `setup` for state management and computed properties.
2. **Nuxt Picture**: Replaced static base64 image with `<nuxt-picture>`.
3. **Simplified Logic**: Enhanced readability and organization of the code.
4. **Import Vapor**: Ensure that `Vapor` is correctly imported for handling file uploads.

This refactoring ensures better performance, readability, and leverages modern Vue.js features.


Remove all the code related to uploading an image


Certainly! Here's the revised version of the component without the image upload functionality:

```vue
<template>
  <div :class="'h-' + height + ' w-' + height + ' relative flex-shrink-0'">
    <span
      :class="[
        loading ? 'animate-pulse' : '',
        height < 24 ? 'ring-2' : 'ring-4',
        loading ? 'bg-slate-200 dark:bg-jovieDark-500' : '',
        contact.color
          ? `ring-${contact.color}-300 dark:ring-${contact.color}-500`
          : 'ring-slate-100 dark:ring-slate-500',
      ]"
      class="group inline-flex h-full w-full items-center justify-center rounded-full bg-slate-300 dark:bg-jovieDark-600"
    >
      <span
        :class="[
          height < 6
            ? 'text-[6px]'
            : height < 8
              ? 'text-2xs'
              : height < 12
                ? 'text-xs'
                : height < 16
                  ? 'text-base'
                  : height < 24
                    ? 'text-lg'
                    : height < 32
                      ? 'text-3xl'
                      : height < 40
                        ? 'text-3xl'
                        : height < 48
                          ? 'text-5xl'
                          : 'text-[8px]',
        ]"
        class="relative inline-block"
      >
        <nuxt-picture
          v-if="hasProfilePic"
          :src="contact.profile_pic_url"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-else-if="contact.full_name || contact.first_name"
          class="font-medium capitalize leading-none text-white"
        >
          {{ initials }}
        </span>
        <nuxt-picture
          v-else
          :src="defaultImage"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-if="editable"
          class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block"
        >
          <label :for="`profile_pic_url_${contact.id}`">
            <PencilIcon
              class="mx-auto h-1/3 w-1/3 text-white/50 dark:text-jovieDark-300/50"
            />
          </label>
        </span>
      </span>
    </span>
  </div>
</template>

<script>
import { ref, computed, defineComponent } from 'vue';
import { PencilIcon } from '@heroicons/vue/24/solid';

export default defineComponent({
  name: 'ContactAvatar',
  components: { PencilIcon },
  props: {
    contact: { type: Object, required: true },
    editable: { type: Boolean, default: false },
    height: { type: Number, default: 8 },
  },
  setup(props) {
    const defaultImage = ref('/defaultAvatar.svg');
    const imageLoadError = ref(false);

    const hasProfilePic = computed(() => {
      return props.contact.profile_pic_url && !imageLoadError.value;
    });

    const initials = computed(() => {
      if (props.contact.full_name) {
        return props.contact.full_name
          .split(' ')
          .map(n => n[0])
          .slice(0, 2)
          .join('');
      }
      const firstInitial = props.contact.first_name?.[0] ?? '';
      const lastInitial = props.contact.last_name?.[0] ?? '';
      return firstInitial + lastInitial;
    });

    const loading = computed(() => {
      return props.contact.id == null;
    });

    return {
      defaultImage,
      imageLoadError,
      hasProfilePic,
      initials,
      loading,
    };
  },
});
</script>
```

### Summary of Changes:
1. **Removed Image Upload Code**: All code related to uploading an image has been removed.
2. **Maintained Image Handling**: The component still handles displaying profile images using `<nuxt-picture>`.
3. **Simplified Setup**: The setup is now straightforward with only the necessary computed properties and reactive state.


We should default to a height of 40. also should me how to put this on my parent component


Sure, I'll set the default height to 40 and show you how to integrate this component into a parent component.

### Updated `ContactAvatar` Component
First, update the `ContactAvatar` component to have a default height of 40:

```vue
<template>
  <div :class="'h-' + height + ' w-' + height + ' relative flex-shrink-0'">
    <span
      :class="[
        loading ? 'animate-pulse' : '',
        height < 24 ? 'ring-2' : 'ring-4',
        loading ? 'bg-slate-200 dark:bg-jovieDark-500' : '',
        contact.color
          ? `ring-${contact.color}-300 dark:ring-${contact.color}-500`
          : 'ring-slate-100 dark:ring-slate-500',
      ]"
      class="group inline-flex h-full w-full items-center justify-center rounded-full bg-slate-300 dark:bg-jovieDark-600"
    >
      <span
        :class="[
          height < 6
            ? 'text-[6px]'
            : height < 8
              ? 'text-2xs'
              : height < 12
                ? 'text-xs'
                : height < 16
                  ? 'text-base'
                  : height < 24
                    ? 'text-lg'
                    : height < 32
                      ? 'text-3xl'
                      : height < 40
                        ? 'text-3xl'
                        : height < 48
                          ? 'text-5xl'
                          : 'text-[8px]',
        ]"
        class="relative inline-block"
      >
        <nuxt-picture
          v-if="hasProfilePic"
          :src="contact.profile_pic_url"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-else-if="contact.full_name || contact.first_name"
          class="font-medium capitalize leading-none text-white"
        >
          {{ initials }}
        </span>
        <nuxt-picture
          v-else
          :src="defaultImage"
          class="h-full w-full rounded-full object-cover object-center"
          :alt="contact.full_name ? `${contact.full_name} Profile Picture` : 'Profile Picture'"
          @error="imageLoadError = true"
        />
        <span
          v-if="editable"
          class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block"
        >
          <label :for="`profile_pic_url_${contact.id}`">
            <PencilIcon
              class="mx-auto h-1/3 w-1/3 text-white/50 dark:text-jovieDark-300/50"
            />
          </label>
        </span>
      </span>
    </span>
  </div>
</template>

<script>
import { ref, computed, defineComponent } from 'vue';
import { PencilIcon } from '@heroicons/vue/24/solid';

export default defineComponent({
  name: 'ContactAvatar',
  components: { PencilIcon },
  props: {
    contact: { type: Object, required: true },
    editable: { type: Boolean, default: false },
    height: { type: Number, default: 40 }, // Default height set to 40
  },
  setup(props) {
    const defaultImage = ref('/defaultAvatar.svg');
    const imageLoadError = ref(false);

    const hasProfilePic = computed(() => {
      return props.contact.profile_pic_url && !imageLoadError.value;
    });

    const initials = computed(() => {
      if (props.contact.full_name) {
        return props.contact.full_name
          .split(' ')
          .map(n => n[0])
          .slice(0, 2)
          .join('');
      }
      const firstInitial = props.contact.first_name?.[0] ?? '';
      const lastInitial = props.contact.last_name?.[0] ?? '';
      return firstInitial + lastInitial;
    });

    const loading = computed(() => {
      return props.contact.id == null;
    });

    return {
      defaultImage,
      imageLoadError,
      hasProfilePic,
      initials,
      loading,
    };
  },
});
</script>
```

### Integrating into a Parent Component
Here’s how you can integrate the `ContactAvatar` component into a parent component:

1. **Create or Update the Parent Component**: Let's assume your parent component is called `UserProfile.vue`.

2. **Import and Register the `ContactAvatar` Component**: In your parent component, import the `ContactAvatar` component and register it.

3. **Use the `ContactAvatar` Component in the Template**: Pass the necessary props to the `ContactAvatar` component.

#### Example Parent Component (`UserProfile.vue`):
```vue
<template>
  <div>
    <h1>User Profile</h1>
    <ContactAvatar :contact="userContact" :editable="true" />
  </div>
</template>

<script>
import { defineComponent, ref } from 'vue';
import ContactAvatar from '@/components/ContactAvatar.vue'; // Adjust the path as needed

export default defineComponent({
  name: 'UserProfile',
  components: {
    ContactAvatar,
  },
  setup() {
    const userContact = ref({
      id: 1,
      full_name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      profile_pic_url: '/path/to/profile-pic.jpg',
      color: 'blue',
    });

    return {
      userContact,
    };
  },
});
</script>
```

### Summary of Steps:
1. **Define the `ContactAvatar` Component**: Ensure it has a default height of 40.
2. **Create or Update the Parent Component**: Import and register the `ContactAvatar` component.
3. **Pass Necessary Props**: Ensure you pass the necessary props (`contact`, `editable`) from the parent component to the `ContactAvatar` component.

With these steps, you can seamlessly integrate the `ContactAvatar` component into your parent component.


<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <div class="text-center mx-auto">
        <ContactAvatar :contact="creator.name" :editable="false" />
        <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          {{ creator.name }}
        </h1>
        <p class="mt-4 text-lg text-gray-600">{{ creator.bio }}</p>
      </div>

      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div v-if="creator.songs.length > 0" class="text-center">
          <h2
            class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl"
          >
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
    </main>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    songs: [
      {
        title: "Never Say A Word",
        slug: "nsaw",
      },
    ],
  },
  kenzie: {
    name: "Kenzie",
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  bio: "",
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>

<script>
export default {
  layout: "links",
};
</script>

<style scoped>
/* Add your custom styles here */
</style>

Center the profile image and make it big. Then 3 social links below the artist name


### Template

```vue
<template>
  <div class="bg-white">
    <main class="pt-10 sm:pt-16">
      <div class="text-center mx-auto">
        <div class="flex justify-center">
          <ContactAvatar :contact="creator" :editable="false" height="40" />
        </div>
        <h1 class="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl mt-4">
          {{ creator.name }}
        </h1>
        <div class="mt-2 flex justify-center space-x-4">
          <a :href="creator.socialLinks.twitter" target="_blank" class="text-blue-500 hover:text-blue-700">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M24 4.557c-.883.392-1.83.656-2.828.775a4.932 4.932 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.916 4.916 0 00-8.379 4.482c-4.083-.205-7.702-2.16-10.126-5.127a4.822 4.822 0 00-.664 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616c-.054 1.983 1.393 3.84 3.442 4.247a4.936 4.936 0 01-2.224.085c.63 1.953 2.445 3.377 4.6 3.419A9.867 9.867 0 010 19.54a13.94 13.94 0 007.548 2.212c9.058 0 14.009-7.506 14.009-14.009 0-.213-.005-.425-.014-.636a10.025 10.025 0 002.457-2.555z"/></svg>
          </a>
          <a :href="creator.socialLinks.instagram" target="_blank" class="text-pink-500 hover:text-pink-700">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c3.292 0 3.696.013 4.988.072 1.284.058 2.143.278 2.656.466a5.373 5.373 0 011.915 1.186 5.373 5.373 0 011.186 1.915c.188.513.408 1.372.466 2.656.059 1.292.072 1.696.072 4.988s-.013 3.696-.072 4.988c-.058 1.284-.278 2.143-.466 2.656a5.373 5.373 0 01-1.186 1.915 5.373 5.373 0 01-1.915 1.186c-.513.188-1.372.408-2.656.466-1.292.059-1.696.072-4.988.072s-3.696-.013-4.988-.072c-1.284-.058-2.143-.278-2.656-.466a5.373 5.373 0 01-1.915-1.186 5.373 5.373 0 01-1.186-1.915c-.188-.513-.408-1.372-.466-2.656-.059-1.292-.072-1.696-.072-4.988s.013-3.696.072-4.988c.058-1.284.278-2.143.466-2.656a5.373 5.373 0 011.186-1.915 5.373 5.373 0 011.915-1.186c.513-.188 1.372-.408 2.656-.466C8.304.013 8.708 0 12 0m0-2c-3.351 0-3.773.013-5.086.072-1.342.06-2.27.271-3.058.57a7.373 7.373 0 00-2.71 1.597 7.373 7.373 0 00-1.597 2.71c-.299.788-.51 1.716-.57 3.058C.013 8.227 0 8.649 0 12s.013 3.773.072 5.086c.06 1.342.271 2.27.57 3.058a7.373 7.373 0 001.597 2.71 7.373 7.373 0 002.71 1.597c.788.299 1.716.51 3.058.57C8.227 23.987 8.649 24 12 24s3.773-.013 5.086-.072c1.342-.06 2.27-.271 3.058-.57a7.373 7.373 0 002.71-1.597 7.373 7.373 0 001.597-2.71c.299-.788.51-1.716.57-3.058C23.987 15.773 24 15.351 24 12s-.013-3.773-.072-5.086c-.06-1.342-.271-2.27-.57-3.058a7.373 7.373 0 00-1.597-2.71 7.373 7.373 0 00-2.71-1.597c-.788-.299-1.716-.51-3.058-.57C15.773.013 15.351 0 12 0z"/></svg>
          </a>
          <a :href="creator.socialLinks.facebook" target="_blank" class="text-blue-700 hover:text-blue-900">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M22.675 0h-21.35C.595 0 0 .595 0 1.325v21.351C0 23.405.595 24 1.325 24H12.81v-9.294H9.692V11.29h3.118V8.594c0-3.1 1.893-4.788 4.659-4.788 1.325 0 2.463.099 2.795.143v3.24H17.57c-1.613 0-1.925.767-1.925 1.891v2.48h3.852l-.502 3.416H15.645V24h7.03c.73 0 1.325-.595 1.325-1.325V1.325C24 .595 23.405 0 22.675 0z"/></svg>
          </a>
        </div>
        <p class="mt-4 text-lg text-gray-600">{{ creator.bio }}</p>
      </div>

      <div class="mx-auto max-w-2xl px-4 pt-10 sm:px-6 lg:max-w-4xl lg:pt-16">
        <div v-if="creator.songs.length > 0" class="text-center">
          <h2 class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
            Songs
          </h2>
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
    </main>
  </div>
</template>

<script setup>
import { useRoute } from "vue-router";
import ContactAvatar from '@/components/ContactAvatar.vue'; // Adjust the path as needed

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    socialLinks: {
      twitter: "https://twitter.com/timwhite",
      instagram: "https://instagram.com/timwhite",


Extract the design from this example and apply it to our page. But make sure we're using our existing way of pulling in data and everything:

<template>
  <div
    v-if="user"
    class="items-top flex max-h-screen min-h-screen justify-center overflow-hidden bg-slate-50 px-4 dark:bg-jovieDark-900 sm:items-center sm:px-6 lg:px-8">
    <div class="mt-8 max-w-md items-center space-y-8 pt-8 sm:mt-0">
      <router-link
        v-if="user.username == currentUser?.username"
        to="/edit-profile"
        class="dark:text-indigio-200 absolute right-0 top-0 cursor-pointer px-4 py-2 text-xs font-bold text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400">
        Edit profile
      </router-link>
      <div>
        <img
          class="block-inline mx-auto mt-0 aspect-square w-48 rounded-full object-cover object-center sm:w-64 2xl:w-80"
          :src="user.profile_pic_url"
          alt="" />
        <div class="mx-auto mt-6 flex 2xl:mt-12">
          <h2
            class="mx-auto flex text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100">
            {{ user.name }}
            <svg
              v-if="user.is_verified"
              xmlns="http://www.w3.org/2000/svg"
              class="-mr-5 h-5 w-5 text-indigo-600 dark:text-indigo-300"
              viewBox="0 0 20 20"
              fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clip-rule="evenodd" />
            </svg>
          </h2>
        </div>
        <p
          class="mt-2 text-center text-sm text-slate-600 dark:text-jovieDark-300">
          {{ user.title }} {{ user.employer ? ' at ' : '' }}
          <a
            v-if="user.employer"
            :href="user.employer_link"
            class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400">
            {{ user.employer }}
          </a>
        </p>
      </div>
      <div
        class="mt-2 2xl:mt-8"
        v-if="user.contact.social_links_with_followers">
        <fieldset class="mt-0 2xl:mt-2">
          <legend class="sr-only">Social links</legend>
          <div
            class="flex grid-cols-3 items-center justify-between gap-2 sm:grid-cols-6">
            <template
              v-for="socialLink in user.contact.social_links_with_followers"
              :key="socialLink.network">
              <SocialIcons
                :countsVisible="true"
                :linkDisabled="!socialLink.url"
                class="mx-auto"
                height="14px"
                :followers="
                  socialLink.followers
                    ? formatCount(socialLink.followers)
                    : socialLink.followers
                "
                :link="socialLink.url ?? '#'"
                :icon="socialLink.network" />
            </template>
          </div>
        </fieldset>
      </div>
      <!--    user.call_to_action -->
      <!--  v-if="user.call_to_action_text" -->
      <a href="#">
        <button
          @click="generateVCF(user)"
          class="mb-0 mt-2 flex w-full items-center justify-center rounded-md border border-transparent bg-indigo-600 px-8 py-3 text-base font-medium text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:bg-indigo-700">
          Save contact
        </button>
      </a>

      <div
        class="border-t-2 border-slate-400 opacity-20 dark:border-jovieDark-border"></div>
      <router-link
        class="dark:text-sltate-300 group mt-1 py-4 text-center text-sm text-slate-500"
        to="signup">
        <div
          class="mx-auto mt-4 flex items-center justify-center text-center text-black dark:text-white">
          <JovieLogo
            iconColor="currentColor"
            height="20px"
            class="opacity-20 group-hover:opacity-100" />
        </div>
        <div
          class="bottom-0 w-full cursor-pointer items-center pb-4 font-semibold text-slate-900 opacity-20 group-hover:opacity-50 dark:text-jovieDark-100">
          Get your profile
        </div>
      </router-link>
    </div>
  </div>
</template>
<script>
import JovieLogo from '../components/JovieLogo.vue';
import ButtonGroup from '../components/ButtonGroup.vue';
import { EnvelopeOpenIcon } from '@heroicons/vue/24/solid';
import store from '../store';
import router from '../router';
import SocialIcons from '../components/SocialIcons.vue';

export default {
  name: 'ContactProfile',
  components: { JovieLogo, ButtonGroup, EnvelopeOpenIcon, SocialIcons },
  props: ['profile', 'socialNetworks'],
  data() {
    return {
      user: null,
      networks: [],
    };
  },
  methods: {
    generateVCF(user) {
      console.log(user);
      let vCard = 'BEGIN:VCARD\n';
      vCard += 'VERSION:3.0\n';
      //if creator has a first name
      if (user.first_name) {
        vCard += 'N:' + user.first_name + ' ' + user.last_name + '\n';
        vCard += 'FN:' + user.first_name + ' ' + user.last_name + '\n';
      } else {
        vCard += 'N:' + user.full_name + '\n';
        vCard += 'FN:' + user.full_name + '\n';
      }
      //if creator has a title
      if (user.title) {
        vCard += 'TITLE:' + user.title + '\n';
      }
      //if creator has a company
      if (user.employer) {
        vCard += 'ORG:' + user.employer + '\n';
      }
      //if creator has a phone number
      if (user.phone_number) {
        vCard += 'TEL;TYPE=WORK,VOICE:' + user.phone_number + '\n';
      }
      //if creator has a email
      if (user.email) {
        vCard += 'EMAIL;TYPE=PREF,INTERNET:' + user.email + '\n';
      }
      //if creator has a website
      if (user.website) {
        vCard += 'URL:' + user.website + '\n';
      }
      //if creator has a address
      if (user.address) {
        vCard += 'ADR;TYPE=WORK:;;' + user.address + ';;;\n';
      }
      //add a note Saved from Jovie
      vCard += 'NOTE:Saved from Jovie\n';
      //if creator has a twitter
      user.contact.social_links_with_followers.forEach((val) => {
        if (val.url) {
          vCard += `X-SOCIALPROFILE;TYPE=${val.network}:` + val.url + '\n';
        }
      });
      console.log(vCard);
      vCard += 'END:VCARD';
      //download the vcard
      const element = document.createElement('a');
      element.setAttribute(
        'href',
        'data:text/plain;charset=utf-8,' + encodeURIComponent(vCard)
      );
      element.setAttribute('download', user.name + '.vcf');
      element.style.display = 'none';
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    },
  },
  mounted() {
    //add segment analytics
    window.analytics.page(this.$route.path);
    if (!this.profile) {
      const username = this.$route.params.username;
      store
        .dispatch('getPublicProfile', { username: username })
        .then((response) => {
          if (response.status) {
            this.user = response.data;
            this.networks = response.networks;
          } else {
            router.push({ name: 'Home' });
          }
        })
        .catch((error) => {
          router.push({ name: 'Home' });
        });
    } else {
      this.user = this.profile;
      this.networks = this.socialNetworks ?? [];
    }
  },
};
</script>


Sure! Here's the updated code where the design from your provided example has been extracted and applied to your page:

### Template

```vue
<template>
  <div
    v-if="creator"
    class="items-top flex max-h-screen min-h-screen justify-center overflow-hidden bg-slate-50 px-4 dark:bg-jovieDark-900 sm:items-center sm:px-6 lg:px-8"
  >
    <div class="mt-8 max-w-md items-center space-y-8 pt-8 sm:mt-0">
      <div>
        <img
          v-if="creator.profile_pic_url"
          class="block-inline mx-auto mt-0 aspect-square w-48 rounded-full object-cover object-center sm:w-64 2xl:w-80"
          :src="creator.profile_pic_url"
          :alt="`${creator.name} Profile Picture`"
        />
        <div class="mx-auto mt-6 flex 2xl:mt-12">
          <h2
            class="mx-auto flex text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100"
          >
            {{ creator.name }}
          </h2>
        </div>
        <div class="mt-2 flex justify-center space-x-4">
          <a
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            target="_blank"
            class="text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" class="w-6 h-6" />
          </a>
        </div>
        <p
          class="mt-2 text-center text-sm text-slate-600 dark:text-jovieDark-300"
        >
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
```

### Script Setup

```vue
<script setup>
import { useRoute } from "vue-router";
import SocialIcons from '@/components/SocialIcons.vue'; // Adjust the path as needed

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    profile_pic_url: "/path/to/profile-pic.jpg", // Adjust path as needed
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    socialLinks: [
      { network: 'twitter', url: 'https://twitter.com/timwhite' },
      { network: 'instagram', url: 'https://instagram.com/timwhite' },
      { network: 'facebook', url: 'https://facebook.com/timwhite' }
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
    profile_pic_url: "/path/to/kenzie-pic.jpg", // Adjust path as needed
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    socialLinks: [
      { network: 'twitter', url: 'https://twitter.com/kenzie' },
      { network: 'instagram', url: 'https://instagram.com/kenzie' },
      { network: 'facebook', url: 'https://facebook.com/kenzie' }
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  profile_pic_url: '',
  bio: "",
  socialLinks: [],
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>
```

### Styles (optional)

Add custom styles if needed in a `<style scoped>` block to further customize the design:

```vue
<style scoped>
/* Add your custom styles here */
</style>
```

### Summary:
1. **Template**: Structured the HTML to include the creator's profile picture, name, bio, and social links.
2. **Script Setup**: Used `useRoute` to fetch the creator's information and passed it to the template. Defined social links in the `creators` object.
3. **Styles**: Provided an optional section for adding custom styles.

This setup should integrate the design into your page while maintaining the existing data-fetching logic. Adjust the image paths and ensure the `SocialIcons` component is correctly implemented in your project.


{'asset_pointer': 'file-service://file-bkxp5iZKkAQE5w9bVlpWmxOq', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1255, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 95314, 'width': 1536}


It looks like the profile picture and social icons are not displaying correctly. Let's make sure the layout is properly centered and that the social icons are correctly integrated. We'll also make sure the `ContactAvatar` component is displaying the image correctly.

### Updated Template
Ensure the `ContactAvatar` component is properly centered and displayed:

```vue
<template>
  <div
    v-if="creator"
    class="items-top flex max-h-screen min-h-screen justify-center overflow-hidden bg-slate-50 px-4 dark:bg-jovieDark-900 sm:items-center sm:px-6 lg:px-8"
  >
    <div class="mt-8 max-w-md items-center space-y-8 pt-8 sm:mt-0">
      <div>
        <ContactAvatar :contact="creator" :editable="false" height="40" />
        <div class="mx-auto mt-6 flex 2xl:mt-12">
          <h2
            class="mx-auto flex text-3xl font-extrabold text-slate-900 dark:text-jovieDark-100"
          >
            {{ creator.name }}
          </h2>
        </div>
        <div class="mt-2 flex justify-center space-x-4">
          <a
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            target="_blank"
            class="text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" class="w-6 h-6" />
          </a>
        </div>
        <p
          class="mt-2 text-center text-sm text-slate-600 dark:text-jovieDark-300"
        >
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
```

### Script Setup

Ensure the script is correctly importing the necessary components and data:

```vue
<script setup>
import { useRoute } from "vue-router";
import SocialIcons from '@/components/SocialIcons.vue'; // Adjust the path as needed
import ContactAvatar from '@/components/ContactAvatar.vue'; // Adjust the path as needed

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();

const creators = {
  tim: {
    name: "Tim White",
    profile_pic_url: "/path/to/profile-pic.jpg", // Adjust path as needed
    bio: "Tim White is a musician and songwriter known for his unique sound and captivating lyrics.",
    socialLinks: [
      { network: 'twitter', url: 'https://twitter.com/timwhite' },
      { network: 'instagram', url: 'https://instagram.com/timwhite' },
      { network: 'facebook', url: 'https://facebook.com/timwhite' }
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
    profile_pic_url: "/path/to/kenzie-pic.jpg", // Adjust path as needed
    bio: "Kenzie is an upcoming artist with a fresh sound and a growing fan base.",
    socialLinks: [
      { network: 'twitter', url: 'https://twitter.com/kenzie' },
      { network: 'instagram', url: 'https://instagram.com/kenzie' },
      { network: 'facebook', url: 'https://facebook.com/kenzie' }
    ],
    songs: [],
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  profile_pic_url: '',
  bio: "",
  socialLinks: [],
  songs: [],
};

definePageMeta({
  layout: "links",
});
</script>
```

### Styles (optional)

Add custom styles if needed in a `<style scoped>` block to further customize the design:

```vue
<style scoped>
/* Add your custom styles here */
</style>
```

### Summary:
1. **Template**: Structured the HTML to include the creator's profile picture, name, bio, and social links. Ensured everything is centered.
2. **Script Setup**: Used `useRoute` to fetch the creator's information and passed it to the template. Defined social links in the `creators` object.
3. **Styles**: Provided an optional section for adding custom styles.

This setup should correctly display the profile picture, name, bio, and social links while maintaining the existing data-fetching logic. Adjust the image paths and ensure the `SocialIcons` component is correctly implemented in your project.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_optimize-vuejs-component-part1]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part3]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part4]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part5]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part6]]
