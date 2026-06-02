---
title: "Vue App Initialization"
type: note
created: 2023-05-12
updated: 2023-05-12
source: chatgpt-export
conversation_id: 7998e2cc-9214-44f9-9344-038f982ca2a2
message_count: 6
tags: [chatgpt, import]
---
# Vue App Initialization

> Conversation ID: 7998e2cc-9214-44f9-9344-038f982ca2a2
> Created: 2023-05-12T07:55:09Z
> Updated: 2023-05-12T07:56:04Z
> Messages: 6

---

## User

import App from './App.vue';

import './bootstrap';
import '../css/app.css';

import * as Vue from 'vue';
import router from './router/index';
import store from './store/index';
import moment from 'moment';
import InstantSearch from 'vue-instantsearch/vue3/es'; // Vue 3
import VueObserveVisibility from 'vue-observe-visibility';
import VueMousetrapPlugin from 'vue-mousetrap';
import VueCookies from 'vue-cookies';
import Notifications from 'notiwind';
import { createHead } from '@vueuse/head';

window.Vapor = require('laravel-vapor');

const myMixin = {};

const app = Vue.createApp({});
app.mixin({
  computed: {
    currentUser() {
      return store.state.AuthState.user;
    },
    contacts() {
      return this.$store.state.crmRecords;
    },
  },
  methods: {
    generateUniqueNumericString(length = 10) {
      let timestamp = new Date().getTime().toString();
      let random = '';
      for (let i = 0; i < length - timestamp.length; i++) {
        random += Math.floor(Math.random() * 10);
      }
      return timestamp + random;
    },
    async reconnectPusher() {
      return new Promise(async (resolve, reject) => {
        await Echo.disconnect();
        await Echo.connect();
        resolve();
      });
    },
    listenEvents(
      channel,
      event,
      successCallback = () => {},
      errorCallback = () => {}
    ) {
      Echo.private(channel).listen(event, (e) => {
        if (e.status) {
          if (e.message) {
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 40000,
              title: 'Successful',
              text: e.message,
            });
          }
          successCallback(e.data);
        } else {
          this.$notify({
            group: 'user',
            type: 'error',
            duration: 40000,
            title: 'Error',
            text: e.message,
          });
          errorCallback();
        }
      });
    },
    asset(path) {
      return Vapor.asset(path);
    },
    unSlugify(value) {
      return value.toString().replaceAll('_', ' ');
    },
    formatCount(value) {
      value = value ? value : 0;
      try {
        if (value < 1000) {
          return value.toFixed(0);
        } else if (value >= 1000 && value < 999999) {
          return (value / 1000).toFixed(0) + 'K';
        } else if (value >= 1000000 && value < 999999999) {
          return (value / 1000000).toFixed(0) + 'M';
        } else if (value >= 1000000000 && value < 999999999999) {
          return (value / 1000000000).toFixed(0) + 'B';
        }
      } catch (e) {
        return 0;
      }
    },
    openLink(link, newWindow) {
      if (link) {
        window.open(link, newWindow ? '_blank' : '');
      }
    },
    formatDate(value, unix = false, humanize = false) {
      if (!value) {
        return moment().format('ddd MMM DD, YYYY [at] HH:mm a');
      }
      let time = moment(value);
      if (unix) {
        time = moment.unix(value);
      }
      if (humanize) {
        let duration = moment.duration(moment().diff(time));
        return duration.humanize(true);
      }
      return time.format('ddd MMM DD, YYYY [at] HH:mm a');
    },
    switchToDefaultImage(e) {
      console.log(this.asset('img/noimage.webp'));
      console.log(e);
      e.target.src = this.asset('img/noimage.webp');
    },
  },
});

axios.interceptors.request.use(
  function (config) {
    // Do something before request is sent.
    if (router.currentRoute.value.name == undefined) {
      delete config.headers.common['Authorization'];
    }
    if (
      router.currentRoute.value.name != undefined &&
      router.currentRoute.value.name != 'Extension'
    ) {
      delete config.headers.common['Authorization'];
    } else {
      let token = localStorage.getItem('jovie_extension');
      if (token) {
        config.headers.common['Authorization'] = `Bearer ${token}`;
      }
    }
    return config;
  },
  function (error) {
    // Do something with request error
    return Promise.reject(error);
  }
);

app.use(router);
app.use(store);
app.use(InstantSearch);
app.use(VueCookies);
app.use(VueObserveVisibility);
app.use(VueMousetrapPlugin);
app.use(Notifications);
app.use(createHead());
app.component('App', App);
app.mount('#app');


---

## Assistant

The code you provided is a Vue.js application entry point. Here's a breakdown of what it does:

1. Imports the necessary dependencies and files.
2. Creates an instance of the Vue application using `Vue.createApp`.
3. Defines a mixin that contains computed properties and methods that can be used across components.
4. Sets up axios interceptors to handle requests. It checks the current route and adds the authorization token to the request headers if necessary.
5. Registers various Vue plugins using the `app.use` method. These plugins include Vue Router, Vuex (store), Vue InstantSearch, Vue Cookies, Vue Observe Visibility, Vue Mousetrap, Notifications, and VueUse Head.
6. Registers the main `App` component using `app.component`.
7. Mounts the Vue application to an element with the ID "app" using `app.mount`.

Overall, this code sets up the necessary configuration and plugins for a Vue.js application and initializes the application by mounting it to an HTML element.

---

## User

Vapor is not defined

---

## Assistant

In the code you provided, there is a line that uses `Vapor`, but it seems that the `Vapor` variable is not defined or imported in the code snippet you shared. 

`Vapor` is not a standard Vue.js or JavaScript object, so it must be defined or imported from a separate module or library. It's possible that `Vapor` is a custom object or a global variable defined in another file that is not included in the code snippet.

To resolve the issue, you need to make sure that the `Vapor` object is properly defined or imported before using it in the code. Check if there are any missing import statements or if there is a separate file that defines the `Vapor` object.

---

## User

 ReferenceError: process is not defined

---

## Assistant

The error "ReferenceError: process is not defined" typically occurs when running JavaScript code that references the `process` object, which is commonly used in Node.js environments but not available in browser-based JavaScript environments.

In the code you provided, it seems that the `process` object is being referenced somewhere, potentially in one of the imported dependencies or within the Vue application setup. However, the `process` object is not available in the browser environment, leading to the ReferenceError.

To resolve this issue, you need to identify the code that references the `process` object and determine if it's necessary for your application. If the code is specifically designed for a Node.js environment and not intended to run in the browser, you may need to refactor or remove that code.

If the code is essential for your application and requires access to environment variables or other Node.js-specific functionality, you may need to consider using a build tool like Webpack or a bundler like Browserify to package your code for the browser and provide appropriate replacements or shims for the missing Node.js-specific objects or functionality.

Additionally, ensure that you are running the code in an appropriate environment. If you're testing the code in a browser, make sure you're running it within a web page or a tool like Vue CLI that sets up the necessary environment for Vue.js applications.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
