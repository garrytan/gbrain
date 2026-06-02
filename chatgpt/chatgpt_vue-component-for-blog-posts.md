---
conversation_id: 485c17da-738a-48a5-807a-e163b3d11469
created: 2023-01-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue component for blog posts
type: guide
updated: 2023-01-05
---

# Vue component for blog posts

**Related:** [[coding_web_dev]]

> Conversation ID: 485c17da-738a-48a5-807a-e163b3d11469
> Created: 2023-01-05T17:51:11Z
> Updated: 2023-01-05T17:51:11Z
> Messages: 6

---

## User

<template>
  <ul role="list" class="mx-auto max-w-prose divide-y divide-slate-200">
    <li
      v-for="post in posts"
      :key="post.id"
      class="mx-auto mt-6 flex px-4 py-4 text-slate-500 sm:px-0">
      <div class="w-24 text-2xs">
        <p class="text-sm font-semibold text-slate-600">v0.0.9</p>

        <p
          :class="{ 'text-indigo-600 dark:text-indigo-400': post.is_new }"
          class="text-slate-600 dark:text-jovieDark-300">
          {{ formatDate(post.publish_date) }}
        </p>
      </div>
      <div class="w-full">
        <router-link
          :to="'/blog/' + post.slug"
          as="h2"
          class="text-3xl font-bold tracking-tight text-slate-800"
          >{{ post.title }}</router-link
        >
        <!--  <img
          :src="post.image_url"
          :alt="post.title"
          class="mt-4 rounded-xl border border-neutral-200 py-4 shadow-lg dark:border-neutral-700" /> -->
        <p
          class="prose mt-4 rounded-md bg-slate-100 px-4 px-4 py-2 text-xs dark:bg-jovieDark-800">
          <MapIcon class="mr-1 inline-block h-4 w-4" />
          As always you can see our product roadmap and contribute to it
          <a href="https://roadmap.jov.ie">here</a>.
        </p>

        <p
          v-if="post.body.length < 200"
          class="prose mt-4"
          v-html="post.body"></p>
        <p v-else class="prose mt-4" v-html="post.excerpt"></p>
        <router-link
          :to="'/blog/' + post.slug"
          class="font-semibold text-slate-600 hover:text-slate-800"
          >Read more</router-link
        >
      </div>
    </li>
  </ul>
</template>

<script>
import axios from 'axios';
import { MapIcon } from '@heroicons/vue/24/solid';
import moment from 'moment';

export default {
  name: 'BlogList',
  components: {
    MapIcon,
  },

  data() {
    return {
      posts: [],
      loading: false,
      error: false,
      status: '',
    };
  },
  created() {
    this.fetchPosts();
  },
  methods: {
    formatDate(date) {
      return moment(date).format('YY.MM.DD');
    },
    fetchPosts() {
      this.loading = true;
      axios
        .get('/api/blog')
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.posts = response.data;
          } else {
          }
        })
        .catch(() => {})
        .finally(() => {
          this.loading = false;
        });
    },
  },
};
</script>


---

## Assistant

This looks like the code for a Vue.js component that displays a list of blog posts. It has a `template` section that defines the HTML structure of the component and a `script` section that contains the component's JavaScript logic.

The component has a `posts` data property that holds an array of blog posts. The `v-for` directive is used to loop through the `posts` array and render a list item for each post. The `formatDate` method is used to format the date of each post using moment.js. The `MapIcon` component is imported and used to display a map icon.

The `fetchPosts` method is used to retrieve the list of blog posts from the server using an HTTP GET request to the '/api/blog' URL. The `axios` library is used to send the request. The method sets the `loading` data property to `true` while the request is in progress, and to `false` when it completes. If the request is successful and the server returns a valid response, the `posts` data property is updated with the list of posts returned by the server.

---

## User

change this to use setup()

---

## Assistant

Here is the same code, but using the `setup` function instead of the component object:

```
<template>
  <ul role="list" class="mx-auto max-w-prose divide-y divide-slate-200">
    <li
      v-for="post in posts"
      :key="post.id"
      class="mx-auto mt-6 flex px-4 py-4 text-slate-500 sm:px-0">
      <div class="w-24 text-2xs">
        <p class="text-sm font-semibold text-slate-600">v0.0.9</p>

        <p
          :class="{ 'text-indigo-600 dark:text-indigo-400': post.is_new }"
          class="text-slate-600 dark:text-jovieDark-300">
          {{ formatDate(post.publish_date) }}
        </p>
      </div>
      <div class="w-full">
        <router-link
          :to="'/blog/' + post.slug"
          as="h2"
          class="text-3xl font-bold tracking-tight text-slate-800"
          >{{ post.title }}</router-link
        >
        <!--  <img
          :src="post.image_url"
          :alt="post.title"
          class="mt-4 rounded-xl border border-neutral-200 py-4 shadow-lg dark:border-neutral-700" /> -->
        <p
          class="prose mt-4 rounded-md bg-slate-100 px-4 px-4 py-2 text-xs dark:bg-jovieDark-800">
          <MapIcon class="mr-1 inline-block h-4 w-4" />
          As always you can see our product roadmap and contribute to it
          <a href="https://roadmap.jov.ie">here</a>.
        </p>

        <p
          v-if="post.body.length < 200"
          class="prose mt-4"
          v-html="post.body"></p>
        <p v-else class="prose mt-4" v-html="post.excerpt"></p>
        <router-link
          :to="'/blog/' + post.slug"
          class="font-semibold text-slate-600 hover:text-slate-800"
          >Read more</router-link
        >
      </div>
    </li>
  </ul>
</template>

<script>
import axios from 'axios';
import { MapIcon } from '@heroicons/vue/24/solid';
import moment from 'moment';
import { ref, onMounted } from 'vue';

export default {
  name: 'BlogList',
  components: {
    MapIcon,
  },
  setup() {
    const posts = ref([]);
    const loading = ref(false);
    const error = ref(false);
    const status = ref('');

    const formatDate = (date) => {
      return moment(date).format('YY.MM.DD');


---

## User

show the full setup()

---

## Assistant

Here is the full `setup` function:

```
import axios from 'axios';
import { MapIcon } from '@heroicons/vue/24/solid';
import moment from 'moment';
import { ref, onMounted } from 'vue';

export default {
  name: 'BlogList',
  components: {
    MapIcon,
  },
  setup() {
    const posts = ref([]);
    const loading = ref(false);
    const error = ref(false);
    const status = ref('');

    const formatDate = (date) => {
      return moment(date).format('YY.MM.DD');
    };

    const fetchPosts = () => {
      loading.value = true;
      axios
        .get('/api/blog')
        .then((response) => {
          response = response.data;
          if (response.status) {
            posts.value = response.data;
          } else {
            status.value = response.status;
            error.value = true;
          }
        })
        .catch(() => {
          error.value = true;
        })
        .finally(() => {
          loading.value = false;
        });
    };

    onMounted(() => {
      fetchPosts();
    });

    return {
      posts,
      loading,
      error,
      status,
      formatDate,
    };
  },
};
```

The `setup` function is a new way to define the logic of a Vue.js component introduced in Vue 3. It replaces the traditional object-based component definition with a function that returns the component's reactive state and methods.

In this case, the `setup` function returns an object with the `posts`, `loading`, `error`, `status`, and `formatDate` properties. These properties are all reactive, which means that they can be used in the component's template and their values will be automatically updated when they change.

The `fetchPosts` function is used to retrieve the list of blog posts from the server using an HTTP GET request to the '/api/blog' URL. The `axios` library is used to send the request. The function sets the `loading` reactive property to `true` while the request is in progress, and to `false` when it completes. If the request is successful and the server returns a valid response, the `posts` reactive property is updated with the list of posts returned by the server.

The `onMounted` hook is used to call the `fetchPosts` function when the component is mounted to the DOM. This ensures that the list of posts is retrieved and displayed as soon as the component is displayed on the page.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
