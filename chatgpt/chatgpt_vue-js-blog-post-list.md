---
conversation_id: e28c2b5c-e608-4b64-b4d9-0e9170374439
created: 2023-01-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue JS Blog Post List
type: guide
updated: 2023-01-05
---

# Vue JS Blog Post List

**Related:** [[coding_web_dev]]

> Conversation ID: e28c2b5c-e608-4b64-b4d9-0e9170374439
> Created: 2023-01-05T22:39:59Z
> Updated: 2023-01-05T22:39:59Z
> Messages: 4

---

## User

<template>
  <ul role="list" class="mx-auto max-w-prose divide-y divide-slate-200">
    <li
      v-for="post in posts"
      :key="post.id"
      class="mx-auto mt-6 flex px-4 py-4 text-slate-500 sm:px-0">
      <div class="w-24 text-2xs">
        <p class="text-sm font-semibold text-slate-600">
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
          As always we welcome you vote on new features & contribute your own
          ideas to the
          <a href="https://roadmap.jov.ie">Jovie Roadmap</a>.
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

This script appears to define a Vue.js component that displays a list of blog posts. The component uses an HTTP client (axios) to fetch a list of posts from an API endpoint (`/api/blog`) and displays the title, excerpt, publish date, and other information for each post. The component also has a method (`formatDate`) that uses the Moment.js library to format the publish date of each post.

When the component is created, it calls the `fetchPosts` method to retrieve the list of posts from the API. The `fetchPosts` method makes an HTTP GET request to the `/api/blog` endpoint using axios and sets the component's `posts` data property to the list of posts returned by the API. If the API request fails, the component sets an error flag (`this.error`) to `true`.

---

## User

how can i order the blog posts so the newest is first

---

## Assistant

To order the blog posts so the newest is displayed first, you can modify the `fetchPosts` method to sort the posts by publish date before setting the `posts` data property. Here's an example of how you could do this:

```
fetchPosts() {
  this.loading = true;
  axios
    .get('/api/blog')
    .then((response) => {
      response = response.data;
      if (response.status) {
        // Sort the posts by publish date, with the newest first
        this.posts = response.data.sort((a, b) => {
          return new Date(b.publish_date) - new Date(a.publish_date);
        });
      } else {
      }
    })
    .catch(() => {})
    .finally(() => {
      this.loading = false;
    });
},
```

This will sort the posts in descending order by publish date, so the newest posts will be displayed first. If you want to display the oldest posts first, you can reverse the sort order by changing the comparison function to `return new Date(a.publish_date) - new Date(b.publish_date);`.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-blog-list-component]]
- [[chatgpt/chatgpt_vuejs-blog-post-component]]
- [[chatgpt/chatgpt_a7x3-blog-healthy-lifestyle]]
- [[chatgpt/chatgpt_a7x3-supplement-list-request]]
- [[chatgpt/chatgpt_add-blog-to-laravel-vue-spa]]
