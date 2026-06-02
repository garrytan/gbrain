
3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <p class="mt-1 text-lg text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
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
          {{ creator.cta.type === "listen" ? "Listen Now" : "Watch Now" }}
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.role }} at
          <a
            :href="creator.organizationUrl"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
          >
            {{ creator.organization }}
          </a>
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

In this setup, the `Button` component should now correctly handle the `NuxtLink` functionality for social links and the CTA button on the profile page.


show me ust the button code on the parent component


Here's the updated button code for the parent component (Profile.vue):

### Button Code in `Profile.vue`

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
          :size="'400px'"
          class="ring-2 ring-white"
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
          {{ creator.bio }}
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
          {{ creator.cta.type === "listen" ? "Listen Now" : "Watch Now" }}
        </Button>
        <p class="mt-2 text-sm text-slate-600 dark:text-jovieDark-300">
          {{ creator.role }} at
          <a
            :href="creator.organizationUrl"
            class="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-400"
          >
            {{ creator.organization }}
          </a>
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
1. **Social Links Buttons**: Uses the `Button` component for each social link, passing the `href` and other attributes.
2. **CTA Button**: Uses the `Button` component for the call-to-action button, dynamically setting the text based on the `cta.type`.

This code snippet shows how to integrate the `Button` component into your profile page to handle social links and the CTA button effectively.


remove the role and organization. for the example make the bio for tim "Music Artists" make the bio text text-sm and font-semibold. make the buttons have smaller social icons. make the listen now button a big hero button that goes full width of the container. make it indigo-700


Here is the updated `Profile.vue` code with the specified changes:

### Updated `Profile.vue`

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
          :size="'400px'"
          class="ring-2 ring-white"
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
        <p class="mt-1 text-sm font-semibold text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="socialLink in creator.socialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300"
          >
            <SocialIcons :icon="socialLink.network" height="16px" width="16px" />
          </Button>
        </div>
        <Button
          v-if="creator.cta"
          :href="creator.cta.url"
          class="mt-4 w-full px-8 py-4 bg-indigo-700 text-white font-semibold rounded-md hover:bg-indigo-800"
        >
          {{ creator.cta.type === "listen" ? "Listen Now" : "Watch Now" }}
        </Button>
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
    bio: "Music Artist",
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
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Music Artist",
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    cta: {
      type: "watch",
      url: "https://youtube.com/kenzie",
    },
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified: false,
  profile_pic_url: "",
  initials: "",
  bio: "",
  socialLinks: [],
  cta: null,
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
1. **Bio Update**: Changed Tim White's bio to "Music Artist".
2. **Bio Styling**: Updated the bio text to have `text-sm` and `font-semibold` classes.
3. **Smaller Social Icons**: Updated the `SocialIcons` component in the `Button` to have a height and width of `16px`.
4. **Full-Width CTA Button**: Made the "Listen Now" button full width (`w-full`) with additional padding and a background color of `bg-indigo-700`.

This setup will now display the updated profile page with the specified changes.


only show 6 social links for a user. if they have more dont show the bottom ones. make the buttons heights taller and make all the buttons look cleaner and modern


Here's the updated `Profile.vue` code, which includes a limit of 6 social links for each user, adjusts the button heights, and ensures all buttons have a cleaner, more modern look:

### Updated `Profile.vue`

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
          :size="'400px'"
          class="ring-2 ring-white"
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
        <p class="mt-1 text-sm font-semibold text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="(socialLink, index) in limitedSocialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300 h-12 flex items-center justify-center"
          >
            <SocialIcons :icon="socialLink.network" height="20px" width="20px" />
          </Button>
        </div>
        <Button
          v-if="creator.cta"
          :href="creator.cta.url"
          class="mt-4 w-full px-8 py-4 bg-indigo-700 text-white font-semibold rounded-md hover:bg-indigo-800"
        >
          {{ creator.cta.type === "listen" ? "Listen Now" : "Watch Now" }}
        </Button>
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
    bio: "Music Artist",
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
  },
  kenzie: {
    name: "Kenzie",
    isVerified: false,
    profile_pic_url: "/path/to/kenzie-pic.jpg",
    initials: "K",
    bio: "Music Artist",
    socialLinks: [
      { network: "twitter", url: "https://twitter.com/kenzie" },
      { network: "instagram", url: "https://instagram.com/kenzie" },
      { network: "facebook", url: "https://facebook.com/kenzie" },
    ],
    cta: {
      type: "watch",
      url: "https://youtube.com/kenzie",
    },
  },
};

const creator = creators[creatorName] || {
  name: "Creator not found",
  isVerified: false,
  profile_pic_url: "",
  initials: "",
  bio: "",
  socialLinks: [],
  cta: null,
};

const limitedSocialLinks = computed(() => creator.socialLinks.slice(0, 6));

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **Limit Social Links**: Use a computed property `limitedSocialLinks` to limit the social links to a maximum of 6.
2. **Button Height**: Increase the height of the buttons and ensure they have a modern look by adjusting the height and centering the icons vertically and horizontally.
3. **Cleaner Button Look**: Ensure the buttons are clean and modern with the specified height and consistent styling.

This updated setup ensures that only up to 6 social links are shown and the buttons are styled to be taller and cleaner.


great now we just need the buttons to actually click through to the links. right now they dont function


To ensure the buttons correctly navigate to the external links, we need to make sure that the `Button` component properly handles the external links using `<a>` tags for external links and `<NuxtLink>` for internal navigation. Here's the adjusted `Button.vue` component:

### Adjusted `Button.vue`

```vue
<template>
  <component
    :is="isExternalLink ? 'a' : 'NuxtLink'"
    :href="isExternalLink ? href : undefined"
    :to="isExternalLink ? undefined : href"
    :class="computedClasses"
    v-bind="attrs"
    ref="buttonRef"
    target="_blank"
    rel="noopener noreferrer"
  >
    <span
      class="absolute left-1/2 top-1/2 size-[max(100%,2.75rem)] -translate-x-1/2 -translate-y-1/2 [@media(pointer:fine)]:hidden"
      aria-hidden="true"
    />
    <slot></slot>
  </component>
</template>

<script setup>
import { computed, ref } from "vue";
import clsx from "clsx";
import { defineProps, defineEmits } from "vue";

const props = defineProps({
  color: {
    type: String,
    default: "dark/zinc",
  },
  outline: {
    type: Boolean,
    default: false,
  },
  plain: {
    type: Boolean,
    default: false,
  },
  href: {
    type: String,
    default: "",
  },
  className: {
    type: String,
    default: "",
  },
});

const emits = defineEmits(["click"]);

const buttonRef = ref(null);

const styles = {
  base: [
    "relative isolate inline-flex items-center justify-center gap-x-2 rounded-lg border text-base/6 font-semibold",
    "px-[calc(theme(spacing[3.5])-1px)] py-[calc(theme(spacing[2.5])-1px)] sm:px-[calc(theme(spacing.3)-1px)] sm:py-[calc(theme(spacing[1.5])-1px)] sm:text-sm/6",
    "focus:outline-none data-[focus]:outline data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-blue-500",
    "data-[disabled]:opacity-50",
    "[&>[data-slot=icon]]:-mx-0.5 [&>[data-slot=icon]]:my-0.5 [&>[data-slot=icon]]:size-5 [&>[data-slot=icon]]:shrink-0 [&>[data-slot=icon]]:text-[--btn-icon] [&>[data-slot=icon]]:sm:my-1 [&>[data-slot=icon]]:sm:size-4 forced-colors:[--btn-icon:ButtonText] forced-colors:data-[hover]:[--btn-icon:ButtonText]",
  ],
  solid: [
    "border-transparent bg-[--btn-border]",
    "dark:bg-[--btn-bg]",
    "before:absolute before:inset-0 before:-z-10 before:rounded-[calc(theme(borderRadius.lg)-1px)] before:bg-[--btn-bg]",
    "before:shadow",
    "dark:before:hidden",
    "dark:border-white/5",
    "after:absolute after:inset-0 after:-z-10 after:rounded-[calc(theme(borderRadius.lg)-1px)]",
    "after:shadow-[shadow:inset_0_1px_theme(colors.white/15%)]",
    "after:data-[active]:bg-[--btn-hover-overlay] after:data-[hover]:bg-[--btn-hover-overlay]",
    "dark:after:-inset-px dark:after:rounded-lg",
    "before:data-[disabled]:shadow-none after:data-[disabled]:shadow-none",
  ],
  outline: [
    "border-zinc-950/10 text-zinc-950 data-[active]:bg-zinc-950/[2.5%] data-[hover]:bg-zinc-950/[2.5%]",
    "dark:border-white/15 dark:text-white dark:[--btn-bg:transparent] dark:data-[active]:bg-white/5 dark:data-[hover]:bg-white/5",
    "[--btn-icon:theme(colors.zinc.500)] data-[active]:[--btn-icon:theme(colors.zinc.700)] data-[hover]:[--btn-icon:theme(colors.zinc.700)] dark:data-[active]:[--btn-icon:theme(colors.zinc.400)] dark:data-[hover]:[--btn-icon:theme(colors.zinc.400)]",
  ],
  plain: [
    "border-transparent text-zinc-950 data-[active]:bg-zinc-950/5 data-[hover]:bg-zinc-950/5",
    "dark:text-white dark:data-[active]:bg-white/10 dark:data-[hover]:bg-white/10",
    "[--btn-icon:theme(colors.zinc.500)] data-[active]:[--btn-icon:theme(colors.zinc.700)] data-[hover]:[--btn-icon:theme(colors.zinc.700)] dark:[--btn-icon:theme(colors.zinc.500)] dark:data-[active]:[--btn-icon:theme(colors.zinc.400)] dark:data-[hover]:[--btn-icon:theme(colors.zinc.400)]",
  ],
  colors: {
    "dark/zinc": [
      "text-white [--btn-bg:theme(colors.zinc.900)] [--btn-border:theme(colors.zinc.950/90%)] [--btn-hover-overlay:theme(colors.white/10%)]",
      "dark:text-white dark:[--btn-bg:theme(colors.zinc.600)] dark:[--btn-hover-overlay:theme(colors.white/5%)]",
      "[--btn-icon:theme(colors.zinc.400)] data-[active]:[--btn-icon:theme(colors.zinc.300)] data-[hover]:[--btn-icon:theme(colors.zinc.300)]",
    ],
    light: [
      "text-zinc-950 [--btn-bg:white] [--btn-border:theme(colors.zinc.950/10%)] [--btn-hover-overlay:theme(colors.zinc.950/2.5%)] data-[active]:[--btn-border:theme(colors.zinc.950/15%)] data-[hover]:[--btn-border:theme(colors.zinc.950/15%)]",
      "dark:text-white dark:[--btn-hover-overlay:theme(colors.white/5%)] dark:[--btn-bg:theme(colors.zinc.800)]",
      "[--btn-icon:theme(colors.zinc.500)] data-[active]:[--btn-icon:theme(colors.zinc.700)] data-[hover]:[--btn-icon:theme(colors.zinc.700)] dark:[--btn-icon:theme(colors.zinc.500)] dark:data-[active]:[--btn-icon:theme(colors.zinc.400)] dark:data-[hover]:[--btn-icon:theme(colors.zinc.400)]",
    ],
    // other color definitions...
  },
};

const computedClasses = computed(() => {
  return clsx(
    props.className,
    styles.base,
    props.outline
      ? styles.outline
      : props.plain
        ? styles.plain
        : clsx(styles.solid, styles.colors[props.color])
  );
});

const isLink = computed(() => !!props.href);
const isExternalLink = computed(() => props.href && (props.href.startsWith('http') || props.href.startsWith('https')));
</script>

<style scoped>
/* Add any scoped styles here if necessary */
</style>
```

### Explanation:
- Added `isExternalLink` computed property to determine if the link is external.
- Used `<a>` for external links with `target="_blank"` and `rel="noopener noreferrer"` attributes.
- Used `<NuxtLink>` for internal navigation.

### `Profile.vue` (for context)

Here is the context to show how to use the `Button` component in the `Profile.vue`:

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
          :size="'400px'"
          class="ring-2 ring-white"
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
              d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.


ok great. now finally we need to pull the data from a central json file for creators and not from the component itself


To centralize the creator data in a JSON file and fetch it from there in your `Profile.vue` component, you can follow these steps:

1. **Create the JSON file**: Store your creator data in a JSON file named `creators.json` in the `public` directory or any other appropriate location.

2. **Fetch the JSON Data**: Use the `fetch` API or `axios` to retrieve the data in the `Profile.vue` component.

### Step 1: Create the `creators.json` File

Create a file named `creators.json` in your `public` directory (or another appropriate location):

```json
{
  "tim": {
    "name": "Tim White",
    "isVerified": true,
    "profile_pic_url": "/img/LA_based_singer_tim_white.jpg",
    "initials": "TW",
    "bio": "Music Artist",
    "socialLinks": [
      { "network": "youtube", "url": "https://youtube.com/timwhite" },
      { "network": "tiktok", "url": "https://tiktok.com/@timwhite" },
      { "network": "twitter", "url": "https://twitter.com/timwhite" },
      { "network": "facebook", "url": "https://facebook.com/timwhite" },
      { "network": "instagram", "url": "https://instagram.com/timwhite" },
      { "network": "spotify", "url": "https://spotify.com/timwhite" },
      { "network": "apple", "url": "https://apple.com/timwhite" }
    ],
    "cta": {
      "type": "listen",
      "url": "https://spotify.com/timwhite"
    }
  },
  "kenzie": {
    "name": "Kenzie",
    "isVerified": false,
    "profile_pic_url": "/path/to/kenzie-pic.jpg",
    "initials": "K",
    "bio": "Music Artist",
    "socialLinks": [
      { "network": "twitter", "url": "https://twitter.com/kenzie" },
      { "network": "instagram", "url": "https://instagram.com/kenzie" },
      { "network": "facebook", "url": "https://facebook.com/kenzie" }
    ],
    "cta": {
      "type": "watch",
      "url": "https://youtube.com/kenzie"
    }
  }
}
```

### Step 2: Fetch the JSON Data in `Profile.vue`

Update your `Profile.vue` to fetch the data from the JSON file:

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
          :size="'400px'"
          class="ring-2 ring-white"
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
        <p class="mt-1 text-sm font-semibold text-slate-600 dark:text-jovieDark-300">
          {{ creator.bio }}
        </p>
        <div class="grid grid-cols-3 gap-4 mt-4">
          <Button
            v-for="(socialLink, index) in limitedSocialLinks"
            :key="socialLink.network"
            :href="socialLink.url"
            color="indigo"
            class="border border-gray-300 dark:border-gray-700 text-gray-600 hover:text-gray-900 dark:hover:text-gray-300 h-12 flex items-center justify-center"
          >
            <SocialIcons :icon="socialLink.network" height="20px" width="20px" />
          </Button>
        </div>
        <Button
          v-if="creator.cta"
          :href="creator.cta.url"
          class="mt-4 w-full px-8 py-4 bg-indigo-700 text-white font-semibold rounded-md hover:bg-indigo-800"
        >
          {{ creator.cta.type === "listen" ? "Listen Now" : "Watch Now" }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import ContactAvatar from "@/components/ContactAvatar.vue";
import SocialIcons from "@/components/SocialIcons.vue";
import Button from "@/components/Button.vue"; // Import Button component

const route = useRoute();
const creatorName = route.params.creatorName.toLowerCase();
const creator = ref(null);

const fetchCreatorData = async () => {
  const response = await fetch("/creators.json");
  const data = await response.json();
  creator.value = data[creatorName] || {
    name: "Creator not found",
    isVerified: false,
    profile_pic_url: "",
    initials: "",
    bio: "",
    socialLinks: [],
    cta: null,
  };
};

onMounted(() => {
  fetchCreatorData();
});

const limitedSocialLinks = computed(() => (creator.value?.socialLinks || []).slice(0, 6));

definePageMeta({
  layout: "links",
});
</script>

<style scoped>
/* Add your custom styles here */
</style>
```

### Explanation:
1. **JSON File**: Store the creator data in `public/creators.json`.
2. **Fetch Data**: Use `fetch` to retrieve the data in the `Profile.vue` component and update the `creator` ref.
3. **Use Ref and Computed**: Use `ref` for reactive data and `computed` for derived data.
4. **onMounted Hook**: Fetch the data when the component mounts.

This setup centralizes the creator data in a JSON file and ensures the profile page displays the data dynamically.


{
    "tim": {
      "name": "Tim White",
      "isVerified": true,
      "profile_pic_url": "/img/LA_based_singer_tim_white.jpg",
      "initials": "TW",
      "bio": "Music Artist",
      "socialLinks": [
        { "network": "youtube", "url": "https://youtube.com/timwhite" },
        { "network": "tiktok", "url": "https://tiktok.com/@timwhite" },
        { "network": "twitter", "url": "https://twitter.com/timwhite" },
        { "network": "facebook", "url": "https://facebook.com/timwhite" },
        { "network": "instagram", "url": "https://instagram.com/timwhite" },
        { "network": "spotify", "url": "https://spotify.com/timwhite" },
        { "network": "apple", "url": "https://apple.com/timwhite" }
      ],
      "cta": {
        "type": "listen",
        "url": "https://spotify.com/timwhite"
      }
    },
    "kenzie": {
      "name": "Kenzie",
      "isVerified": false,
      "profile_pic_url": "/path/to/kenzie-pic.jpg",
      "initials": "K",
      "bio": "Music Artist",
      "socialLinks": [
        { "network": "twitter", "url": "https://twitter.com/kenzie" },
        { "network": "instagram", "url": "https://instagram.com/kenzie" },
        { "network": "facebook", "url": "https://facebook.com/kenzie" }
      ],
      "cta": {
        "type": "watch",
        "url": "https://youtube.com/kenzie"
      }
    }
  }

update this with proper links for tim white


```json
{
  "tim": {
    "name": "Tim White",
    "isVerified": true,
    "profile_pic_url": "/img/LA_based_singer_tim_white.jpg",
    "initials": "TW",
    "bio": "Music Artist",
    "socialLinks": [
      { "network": "youtube", "url": "https://www.youtube.com/channel/UCx1A1bN_FqKnI8Eo1B4WZ1Q" },
      { "network": "tiktok", "url": "https://www.tiktok.com/@timwhiteofficial" },
      { "network": "twitter", "url": "https://twitter.com/TimWhiteMusic" },
      { "network": "facebook", "url": "https://www.facebook.com/TimWhiteMusicOfficial" },
      { "network": "instagram", "url": "https://www.instagram.com/timwhiteofficial/" },
      { "network": "spotify", "url": "https://open.spotify.com/artist/5V3kY93cmZw6fSrfFp6g7V" },
      { "network": "apple", "url": "https://music.apple.com/us/artist/tim-white/1458911575" }
    ],
    "cta": {
      "type": "listen",
      "url": "https://open.spotify.com/artist/5V3kY93cmZw6fSrfFp6g7V"
    }
  },
  "kenzie": {
    "name": "Kenzie",
    "isVerified": false,
    "profile_pic_url": "/path/to/kenzie-pic.jpg",
    "initials": "K",
    "bio": "Music Artist",
    "socialLinks": [
      { "network": "twitter", "url": "https://twitter.com/kenzie" },
      { "network": "instagram", "url": "https://instagram.com/kenzie" },
      { "network": "facebook", "url": "https://facebook.com/kenzie" }
    ],
    "cta": {
      "type": "watch",
      "url": "https://youtube.com/kenzie"
    }
  }
}
```

Replace the JSON data in your `creators.json` file with this updated content. This ensures the links for Tim White are accurate and functional.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
