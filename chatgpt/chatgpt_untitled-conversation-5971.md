---
title: "Untitled Conversation 5971"
type: note
created: 2022-12-15
updated: 2022-12-15
source: chatgpt-export
conversation_id: 7f28cd38-19a7-49e9-9ea7-80a180003a78
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 5971

> Conversation ID: 7f28cd38-19a7-49e9-9ea7-80a180003a78
> Created: 2022-12-15T05:59:16Z
> Updated: 2022-12-15T05:59:16Z
> Messages: 2

---

## User

How can i setup routing on an application using gridsome for my external marketing pages and vue.js as an SPA for the rest of the site

---

## Assistant

To set up routing on an application using Gridsome and Vue.js, you can use the `@gridsome/vue-router` package to handle routing for the Gridsome part of the site, and the `vue-router` package for the Vue.js Single-Page Application (SPA) portion.

Here is an example of how you could set this up:

1. Install the `@gridsome/vue-router` and `vue-router` packages:

```
npm install @gridsome/vue-router vue-router
```

2. In your Gridsome `gridsome.config.js` file, add the `@gridsome/vue-router` plugin:

```
module.exports = {
  plugins: [
    {
      use: '@gridsome/vue-router',
      options: {
        // options for the plugin
      }
    }
  ]
}
```

3. In your Vue.js SPA, create a new `router.js` file and add the following code to it:

```
import Vue from 'vue'
import Router from 'vue-router'

Vue.use(Router)

const router = new Router({
  // add your routes here
})

export default router
```

4. In your main Vue.js app file (e.g. `main.js`), import the `router.js` file and use it to create a new Vue instance:

```
import Vue from 'vue'
import App from './App.vue'
import router from './router'

new Vue({
  el: '#app',
  router,
  render: h => h(App)
})
```

This should set up routing for both the Gridsome and Vue.js parts of your application. You can then add routes to the `router.js` file for the Vue.js SPA and use the `<g-link>` component in your Gridsome templates to create links to those routes.

For more detailed instructions and examples, you can refer to the documentation for `@gridsome/vue-router` and `vue-router`.
