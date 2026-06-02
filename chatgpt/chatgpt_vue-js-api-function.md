---
conversation_id: d0d1ad62-ceeb-4c44-b30e-13c0cefa5ecc
created: 2023-01-07
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue JS API Function
type: note
updated: 2023-01-07
---

# Vue JS API Function

**Related:** [[coding_web_dev]]

> Conversation ID: d0d1ad62-ceeb-4c44-b30e-13c0cefa5ecc
> Created: 2023-01-07T04:17:07Z
> Updated: 2023-01-07T04:17:07Z
> Messages: 4

---

## User

write a vue js funciton to get the blog post for the current page from the api.

the api end point is /api/blog/{slug}

and the slug is passed in the url /blog/{slug}

the api returns data like this:
{"status":true,"data":{"id":9,"title":"Fixes and improvements","excerpt":"","author":"Tim White","image_url":"","slug":"improvements-and-fixes","category":"changelog","publish_date":"2023-01-05 22:19:28","body":"<p class=\"prose mt-4\"> Minor Tweeaks &amp; UI improvements. As always you can see our product roadmap and contribute to it <a href=\"https:\/\/roadmap.jov.ie\">here<\/a>. <\/p><h4 class=\"prose mt-4 font-bold\">Features<\/h4><ul class=\"prose list-outside list-disc\"><li class=\"prose\">Added keyboard shortcuts to menus.<\/li><li class=\"prose\">Added App versions to improve support.<\/li><li class=\"prose\"> We know automitically clear cache when loading new versions of Jovie. This should result in less issues &amp; faster access to new features. <\/li><\/ul><h4 class=\"prose mt-4 font-bold\">Fixes &amp; Improvements<\/h4><ul class=\"prose list-outside list-disc\"><li class=\"prose\"> We've made some big improvements under the hood that should lead to big performance pay off in a future release. <\/li><li class=\"prose\">Various UI Improvements and bug fixes.<\/li><li class=\"prose\"> Fixed an issue where contacts disappeared when updating data. <\/li><\/ul>","created_at":"2023-01-05T04:23:12.000000Z","updated_at":"2023-01-05T04:23:12.000000Z"}}

---

## Assistant

Here's a Vue.js function that fetches the blog post for the current page from the API:

```
async getBlogPost() {
  try {
    // Get the slug from the URL
    const slug = this.$route.params.slug;

    // Fetch the blog post from the API
    const response = await axios.get(`/api/blog/${slug}`);
    const blogPost = response.data.data;

    // Set the blog post data in the component's data
    this.blogPost = blogPost;
  } catch (error) {
    console.error(error);
  }
}
```

This function uses the `$route` object to get the slug from the URL, then makes a GET request to the API using the axios library. If the request is successful, it sets the blog post data in the component's data. If there is an error, it logs the error to the console.

---

## User

 getBlogPost() {
      try {
        // Get the slug from the URL
        const slug = this.$route.params.slug;

        // Fetch the blog post from the API
        const response = axios.get(`/api/blog/${slug}`);
        const blogPost = response.data;

        // Set the blog post data in the component's data
        this.post = blogPost;
      } catch (error) {
        console.error(error);
      }
    },
  },

---

## Assistant

This code looks like it's missing the `async` keyword before the `getBlogPost()` function. Without the `async` keyword, the `await` keyword inside the function will not work.

Here's the corrected code:

```
async getBlogPost() {
  try {
    // Get the slug from the URL
    const slug = this.$route.params.slug;

    // Fetch the blog post from the API
    const response = await axios.get(`/api/blog/${slug}`);
    const blogPost = response.data;

    // Set the blog post data in the component's data
    this.post = blogPost;
  } catch (error) {
    console.error(error);
  }
},
```

Note that the `response.data` property holds the actual data returned by the API, rather than the object that contains the data and the status. So you should assign `response.data` to `blogPost` instead of `response.data.data`.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
