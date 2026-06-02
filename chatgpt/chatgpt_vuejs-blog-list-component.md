---
title: "Vue.js Blog List Component"
type: guide
created: 2023-01-05
updated: 2023-01-05
source: chatgpt-export
conversation_id: dbabdf79-b949-438b-b3f4-c743d7dfb0b4
message_count: 6
tags: [chatgpt, import, code]
---
# Vue.js Blog List Component

> Conversation ID: dbabdf79-b949-438b-b3f4-c743d7dfb0b4
> Created: 2023-01-05T17:23:37Z
> Updated: 2023-01-05T17:23:37Z
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

        <p>{{ post.isLatest ? 'Just Released!' : post.formattedDate }}</p>
      </div>
      <div class="w-full">
        <router-link
          :to="'/blog/' + post.slug"
          as="h2"
          class="text-3xl font-bold tracking-tight text-slate-800"
          >{{ post.title }}</router-link
        >
        <img
          :src="asset('post.image_url')"
          :alt="post.title"
          class="mt-4 rounded-xl border border-neutral-200 py-4 shadow-lg dark:border-neutral-700" />
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

This looks like a Vue.js component that displays a list of blog posts in a page. The component has a `posts` data property that holds an array of blog posts. It uses the `v-for` directive to iterate over the array and render a list item for each post.

The component has a `created` hook that runs the `fetchPosts` method when the component is created. The `fetchPosts` method uses axios to make a GET request to the '/api/blog' route to retrieve the blog posts. When the response is received, it updates the `posts` data property with the blog posts data.

The component also has a `MapIcon` component that is being rendered as a child element inside the list item. It looks like the `MapIcon` component is being imported from the '@heroicons/vue/24/solid' package.

Finally, the component uses the `v-html` directive to bind and render the `post.body` and `post.excerpt` properties as HTML. This is useful for rendering dynamic HTML content in a template. However, be aware that rendering raw HTML from user input can be a security risk if not properly sanitized.

---

## User

lets make the formatteddate work

---

## Assistant

To make the `formattedDate` property work, you need to add a computed property to the component that formats the date for each blog post.

Here's an example of how you can do this:

```
computed: {
  formattedDate() {
    return (post) => {
      // Calculate the difference between the post's date and the current date
      const diff = Math.abs(new Date() - new Date(post.date));

      // Calculate the number of days between the dates
      const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

      if (days < 1) {
        // If the post was published less than a day ago, return 'Just Released!'
        return 'Just Released!';
      } else {
        // Otherwise, format the date using the Intl.DateTimeFormat method
        const dateOptions = { year: 'numeric', month: 'long', day: 'numeric' };
        return new Intl.DateTimeFormat('en-US', dateOptions).format(new Date(post.date));
      }
    }
  }
},
```

Then, in the template, you can use the computed property like this:

```
<template>
  <!-- ... -->
  <li
    v-for="post in posts"
    :key="post.id"
    class="mx-auto mt-6 flex px-4 py-4 text-slate-500 sm:px-0">
    <div class="w-24 text-2xs">
      <p class="text-sm font-semibold text-slate-600">v0.0.9</p>

      <p>{{ formattedDate(post) }}</p>
    </div>
  <!-- ... -->
</template>
```

This will display 'Just Released!' if the post was published less than a day ago, and the formatted date (e.g. 'January 5, 2021') for older posts.


---

## User

lets make the date format yy.mm.dd

---

## Assistant

To format the date as 'yy.mm.dd', you can modify the computed property like this:

```
computed: {
  formattedDate() {
    return (post) => {
      // Calculate the difference between the post's date and the current date
      const diff = Math.abs(new Date() - new Date(post.date));

      // Calculate the number of days between the dates
      const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

      if (days < 1) {
        // If the post was published less than a day ago, return 'Just Released!'
        return 'Just Released!';
      } else {
        // Otherwise, format the date using the Intl.DateTimeFormat method
        const dateOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
        return new Intl.DateTimeFormat('en-US', dateOptions).format(new Date(post.date)).replace(/,/g, '');
      }
    }
  }
},
```

This will display 'Just Released!' if the post was published less than a day ago, and the formatted date (e.g. '21.01.05') for older posts.

Note that the `replace(/,/g, '')` call at the end removes any commas from the formatted date. This is because the `Intl.DateTimeFormat` method may include commas in the formatted date, depending on the formatting options and the locale.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
