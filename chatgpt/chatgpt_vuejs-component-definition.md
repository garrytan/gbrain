---
title: "Vue.js Component Definition"
type: note
created: 2023-02-04
updated: 2023-02-04
source: chatgpt-export
conversation_id: c899a217-aa99-4991-994c-baf5840d28ac
message_count: 6
tags: [chatgpt, import]
---
# Vue.js Component Definition

> Conversation ID: c899a217-aa99-4991-994c-baf5840d28ac
> Created: 2023-02-04T22:41:50Z
> Updated: 2023-02-04T22:41:50Z
> Messages: 6

---

## User

<template>
  <div class="w-full items-center px-4">
    <h1
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <component
        :is="icon"
        :class="iconColor"
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true" />
      {{ headerText + ' Contacts' }}
    </h1>
    <p class="text-2xs font-light text-slate-600">
      {{ contactCount }}
    </p>
  </div>
</template>

<script>
import { UserGroupIcon, HeartIcon, UserIcon } from '@heroicons/vue/24/solid';
export default {
  props: ['header', 'subheader'],
  components: {
    UserGroupIcon,
    HeartIcon,
    UserIcon,
  },
  computed: {
    icon() {
      if (this.header.includes('all')) {
        return UserGroupIcon;
      } else if (this.header.includes('favourites')) {
        return HeartIcon;
      } else {
        return UserIcon;
      }
    },
    iconColor() {
      if (this.header.includes('favourites')) {
        return 'text-red-400';
      } else if (this.header.includes('archive')) {
        return 'text-blue-400';
      } else {
        return 'text-purple-400';
      }
    },
    contactCount() {
      if (this.header.includes('all')) {
        return `${this.subheader.total} Contacts`;
      } else {
        return `${this.subheader[this.header]} Contacts`;
      }
    },
    headerText() {
      if (this.header.includes('favourites')) {
        return 'Favorited';
      } else {
        return this.header;
      }
    },
  },
};
</script>


---

## Assistant

This is a Vue.js component that displays a header with an icon and a subheader displaying the number of contacts. The header text and the icon type depend on the value of the `header` prop, while the contact count is based on the `subheader` prop. The icon type can be either `UserGroupIcon`, `HeartIcon`, or `UserIcon` depending on whether `header` contains the string 'all', 'favourites', or neither respectively. The color of the icon also depends on the value of `header` and can be either 'purple', 'red', or 'blue'.

---

## User

add skeleton loaders to the component

---

## Assistant

Here's an example of how you can add skeleton loaders to the component:

<template>
  <div class="w-full items-center px-4">
    <h1
      v-if="!loading"
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100"
    >
      <component
        :is="icon"
        :class="iconColor"
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true"
      />
      {{ headerText + ' Contacts' }}
    </h1>
    <h1 v-else class="skeleton-text mr-2">{{ headerText }} Contacts</h1>
    <p
      v-if="!loading"
      class="text-2xs font-light text-slate-600"
    >
      {{ contactCount }}
    </p>
    <p v-else class="skeleton-text">Contacts</p>
  </div>
</template>

<script>
import { UserGroupIcon, HeartIcon, UserIcon } from '@heroicons/vue/24/solid';

export default {
  props: ['header', 'subheader', 'loading'],
  components: {
    UserGroupIcon,
    HeartIcon,
    UserIcon,
  },
  computed: {
    icon() {
      if (this.header.includes('all')) {
        return UserGroupIcon;
      } else if (this.header.includes('favourites')) {
        return HeartIcon;
      } else {
        return UserIcon;
      }
    },
    iconColor() {
      if (this.header.includes('favourites')) {
        return 'text-red-400';
      } else if (this.header.includes('archive')) {
        return 'text-blue-400';
      } else {
        return 'text-purple-400';
      }
    },
    contactCount() {
      if (this.header.includes('all')) {
        return `${this.subheader.total} Contacts`;
      } else {
        return `${this.subheader[this.header]} Contacts`;
      }
    },
    headerText() {
      if (this.header.includes('favourites')) {
        return 'Favorited';
      } else {
        return this.header;
      }
    },
  },
};
</script>

Here, we have added a new prop `loading` that determines whether the component is in a loading state or not. If the value of `loading` is `true`, the header and the subheader are replaced with skeleton loaders. If `loading` is `false`, the original header and subheader are displayed.

---

## User

make loading true by default

---

## Assistant

<template>
  <div class="w-full items-center px-4" v-if="!loading">
    <h1
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <component
        :is="icon"
        :class="iconColor"
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true" />
      {{ headerText + ' Contacts' }}
    </h1>
    <p class="text-2xs font-light text-slate-600">
      {{ contactCount }}
    </p>
  </div>
  <div v-else>
    <div class="w-full h-12 bg-slate-200 rounded-md my-2"></div>
    <div class="w-full h-6 bg-slate-200 rounded-md my-2"></div>
  </div>
</template>

<script>
import { UserGroupIcon, HeartIcon, UserIcon } from '@heroicons/vue/24/solid';
export default {
  props: ['header', 'subheader'],
  data() {
    return {
      loading: true,
    };
  },
  components: {
    UserGroupIcon,
    HeartIcon,
    UserIcon,
  },
  computed: {
    icon() {
      if (this.header.includes('all')) {
        return UserGroupIcon;
      } else if (this.header.includes('favourites')) {
        return HeartIcon;
      } else {
        return UserIcon;
      }
    },
    iconColor() {
      if (this.header.includes('favourites')) {
        return 'text-red-400';
      } else if (this.header.includes('archive')) {
        return 'text-blue-400';
      } else {
        return 'text-purple-400';
      }
    },
    contactCount() {
      if (this.header.includes('all')) {
        return `${this.subheader.total} Contacts`;
      } else {
        return `${this.subheader[this.header]} Contacts`;
      }
    },
    headerText() {
      if (this.header.includes('favourites')) {
        return 'Favorited';
      } else {
        return this.header;
      }
    },
  },
};
</script>


**Topic:** [[chatgpt-clusters/coding_web_dev]]
