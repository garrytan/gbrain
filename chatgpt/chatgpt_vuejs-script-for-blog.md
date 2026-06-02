---
conversation_id: 8946ee29-7d02-4d08-8669-3e1ddd2ba151
created: 2023-01-08
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js script for blog
type: note
updated: 2023-01-08
---

# Vue.js script for blog

> Conversation ID: 8946ee29-7d02-4d08-8669-3e1ddd2ba151
> Created: 2023-01-08T19:52:32Z
> Updated: 2023-01-08T19:52:32Z
> Messages: 4

---

## User


<script setup>
import axios from 'axios';
import { MapIcon } from '@heroicons/vue/24/solid';
import moment from 'moment';
import { ref, onMounted } from 'vue';

const posts = ref([]);
const loading = ref(false);
const error = ref(false);

async function fetchPosts() {
  loading.value = true;
  try {
    let response = await axios.get('/api/blog');
    response = response.data;
    if (response.status) {
      // Sort the posts by publish date, with the newest first
      posts.value = response.data.sort((a, b) => {
        return new Date(b.publish_date) - new Date(a.publish_date);
      });
    } else {
    }
  } catch (err) {
    error.value = true;
  } finally {
    loading.value = false;
  }
}

//

function formatDate(date) {
  return moment(date).format('YY.MM.DD');
}

onMounted(() => {
  fetchPosts();
});
</script>

---

## Assistant

This looks like a Vue.js script for setting up and interacting with a blog application. It appears to be using the `axios` library to make a request to an API to fetch a list of blog posts. The script also uses the `moment` library to format dates. When the component is mounted, the `fetchPosts` function is called to get the list of posts from the API. The list of posts is then sorted by the publish date, with the newest posts first. The `formatDate` function is used to format a date as a string in the format 'YY.MM.DD'.

---

## User

add a boolean prop for catTags

---

## Assistant

To add a boolean prop for catTags to your Vue component, you can do the following:

1. In the component's `props` option, add a prop for `catTags`:

```
props: {
  catTags: {
    type: Boolean,
    default: false
  }
}
```

2. In the template, you can use the `catTags` prop to conditionally render content based on its value:

```
<template>
  <div>
    <!-- Render something if catTags is true -->
    <div v-if="catTags">
      <!-- content -->
    </div>
    <!-- Render something if catTags is false -->
    <div v-else>
      <!-- content -->
    </div>
  </div>
</template>
```

3. In the component's script, you can use the `catTags` prop to control the behavior of the component based on its value:

```
<script>
export default {
  props: {
    catTags: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      // data
    }
  },
  methods: {
    // methods
  },
  created() {
    if (this.catTags) {
      // Do something if catTags is true
    } else {
      // Do something if catTags is false
    }
  }
}
</script>
```

You can then pass a value for `catTags` when you use the component in your app:

```
<template>
  <MyComponent v-bind:catTags="true" />
</template>
```


**Topic:** [[chatgpt-clusters/coding_web_dev]]
