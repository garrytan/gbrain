---
title: "Vue.js Routes Summary"
type: guide
created: 2023-01-04
updated: 2023-01-04
source: chatgpt-export
conversation_id: 3af8fe42-0d0d-4f8c-a5f2-15149510dcc4
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Vue.js Routes Summary

> Conversation ID: 3af8fe42-0d0d-4f8c-a5f2-15149510dcc4
> Created: 2023-01-04T22:55:51Z
> Updated: 2023-01-04T22:55:51Z
> Messages: 8

---

## User

import { authenticationGuard } from '../middlewares/auth';
import { publicProfile } from '../middlewares/publicProfile';

import store from '../store';

function loadPage(page) {
  return () => import(`./../views/${page}.vue`);
}

export const routes = [
  {
    name: 'Home',
    path: '/',
    component: loadPage('Home'),
    meta: {
      requiresAuth: false,
      layout: 'default',
    },
  },
  {
    name: 'Changelog',
    path: '/changelog',
    component: loadPage('ChangeLog'),
    meta: {
      requiresAuth: false,
      layout: 'default',
    },
  },
  {
    name: 'Pricing',
    path: '/pricing',
    component: loadPage('Pricing'),
    meta: {
      layout: 'default',
      requiresAuth: false,
    },
  },
  {
    name: 'Support',
    path: '/support',
    //redirect to https://support.jov.ie/
    beforeEnter(to, from, next) {
      window.open('https://support.jov.ie/', '_self');
    },
  },
  {
    name: 'Careers',
    path: '/careers',
    component: loadPage('Careers'),
    meta: {
      layout: 'default',
      requiresAuth: false,
    },
  },
  {
    name: 'Relationship Management',
    path: '/relationship-management',
    component: loadPage('RelationshipManagement'),
    meta: {
      layout: 'default',
      requiresAuth: false,
    },
  },
  {
    name: 'Invest in Jovie',
    path: '/invest',
    beforeEnter(to, from, next) {
      window.open('https://stack.angellist.com/s/qo9maosy1o', '_self');
    },
  },
  {
    name: 'YC Demo Video',
    path: '/yc-demo-video',
    beforeEnter(to, from, next) {
      window.open(
        'https://www.loom.com/share/621ed0f9a53848c4858b3b9f8f9d22c6',
        '_self'
      );
    },
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: 'Data',
    path: '/data',
    component: loadPage('OurData'),
    meta: {
      layout: 'default',
      requiresAuth: false,
    },
  },
  {
    name: 'Enrichment',
    path: '/enrichment',
    component: loadPage('Enrichment'),
    meta: {
      layout: 'default',
      requiresAuth: false,
    },
  },
  {
    name: 'Account',
    path: '/account',
    component: loadPage('Account'),
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
    children: [
      {
        path: 'team',
      },
    ],
  },
  {
    name: 'Billing',
    path: '/billing',
    component: loadPage('Account'),
    props: { defaultTab: 2 },
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'password',
    path: '/password',
    component: loadPage('Account'),
    props: { defaultTab: 1 },
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Team',
    path: '/team',
    component: loadPage('Account'),
    props: { defaultTab: 3 },
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Extension',
    path: '/extension',
    component: loadPage('AppExtension'),
    meta: {
      layout: 'Minimal',
      requiresAuth: true,
    },
  },
  {
    name: 'Dashboard',
    path: '/dashboard',
    component: loadPage('Dashboard'),
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Contacts',
    path: '/contacts',
    component: loadPage('Crm'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Contact Card',
    path: '/:username/contact-card',
    component: loadPage('ContactCard'),
    meta: {
      layout: 'Minimal',
      requiresAuth: false,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Edit Profile',
    path: '/edit-profile',
    component: loadPage('ProfileSetup'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Meet Jovie',
    path: '/meet-jovie',
    component: loadPage('MeetJovie'),
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: 'Request A Feature',
    path: '/request-a-feature',
    beforeEnter(to, from, next) {
      window.open('https://roadmap.jov.ie/feature-requests', '_self');
    },
  },
  {
    name: 'Roadmap',
    path: '/roadmap',
    beforeEnter(to, from, next) {
      window.open('https://roadmap.jov.ie', '_self');
    },
  },
  {
    name: 'Jovie Profile',
    path: '/profiles',
    component: loadPage('JovieProfile'),
    meta: {
      layout: 'Default',
      requiresAuth: false,
    },
  },
  {
    name: 'Terms',
    path: '/terms',
    component: loadPage('Terms'),
    meta: {
      layout: 'Default',
      requiresAuth: false,
    },
  },
  {
    name: 'Legal',
    path: '/legal',
    component: loadPage('Legal'),
    meta: {
      layout: 'Default',
      requiresAuth: false,
    },
  },
  {
    name: 'Privacy',
    path: '/privacy',
    component: loadPage('Legal'),
    props: { defaultTab: 0 },
    meta: {
      layout: 'Default',
      requiresAuth: false,
    },
  },
  {
    name: 'Terms',
    path: '/terms',
    component: loadPage('Legal'),
    props: { defaultTab: 1 },
    meta: {
      layout: 'Default',
      requiresAuth: false,
    },
  },

  {
    name: 'Demo',
    path: '/demo',
    beforeEnter(to, from, next) {
      window.open('mailto:sales@jov.ie', '_blank');
    },
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: 'Creators',
    path: '/creators',
    beforeEnter(to, from, next) {
      window.open('https://u3yaoaf518v.typeform.com/to/lxFUTGnY', '_blank');
    },
    meta: {
      requiresAuth: true,
      requiresSubscribe: true,
    },
  },
  {
    name: 'Status',
    path: '/status',
    beforeEnter(to, from, next) {
      window.open('https://jovie.statuspage.io/', '_blank');
    },
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: 'Import',
    path: '/import',
    component: loadPage('Import'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Admin Dashboard',
    path: '/admin',
    component: loadPage('AdminDashboard'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresAdmin: true,
    },
  },
  {
    name: 'Outreach',
    path: '/outreach',
    component: loadPage('Outreach'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: true,
    },
  },
  {
    name: 'Discovery',
    path: '/discovery',
    component: loadPage('Search'),
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Analytics',
    path: '/analytics',
    component: loadPage('Analytics'),
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Campaigns',
    path: '/campaigns',
    component: loadPage('Campaigns'),
    meta: {
      layout: 'App',
      requiresAuth: true,
    },
  },
  {
    name: 'Create Account',
    path: '/signup',
    component: loadPage('Signup'),
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'forget-password',
    path: '/forgot-password',
    component: loadPage('ForgotPassword'),
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'reset-password',
    path: '/reset-password',
    component: loadPage('ResetPassword'),
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'reset-password',
    path: '/reset-password',
    component: loadPage('ResetPassword'),
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'Login',
    path: '/login',
    component: loadPage('Login'),
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'onboarding',
    path: '/onboarding',
    component: loadPage('OnboardingScreen'),
    meta: {
      layout: 'Minimal',
      requiresAuth: true,
    },
  },
  {
    name: 'Creator Overview',
    path: '/overview/:id',
    component: loadPage('CreatorOverview'),
    props: true,
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Pipeline',
    path: '/pipeline',
    component: loadPage('Pipeline'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresAdmin: true,
      requiresSubscribe: true,
    },
  },
  {
    name: 'Search',
    path: '/search',
    component: loadPage('Search'),
    meta: {
      layout: 'App',
      requiresAuth: true,
      requiresSubscribe: true,
    },
  },
  {
    name: 'Brand',
    path: '/brand',
    component: loadPage('MarketingAssets'),
    meta: {
      layout: 'Default',
      requiresAuth: false,
      requiresSubscribe: false,
    },
  },
  {
    name: 'Chrome Extension',
    path: '/chrome-extension',

    beforeEnter(to, from, next) {
      window.location.href =
        'https://chrome.google.com/webstore/detail/jovie/daeopelnocmnhbkjbjmhckgjgheioafj';
    },
  },
  {
    name: 'Profile',
    path: '/:username',
    component: loadPage('Profile'),
    beforeEnter: publicProfile,
    props: true,
    meta: {
      layout: 'Minimal',
    },
  },
  {
    name: 'API',
    path: '/api',
    beforeEnter(to, from, next) {
      window.open(
        'https://u3yaoaf518v.typeform.com/to/pngWHiwK?typeform-source=admin.typeform.com',
        '_blank'
      );
    },
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: 'Slack Community',
    path: '/slack-community',
    beforeEnter(to, from, next) {
      window.open(
        'https://join.slack.com/t/joviecommunity/shared_invite/zt-1gdffx9bp-gjhCk1ihRUOnv54Pc5sm5Q',
        '_blank'
      );
    },
    meta: {
      requiresAuth: false,
    },
  },
  {
    name: '404',
    path: '/notfound',
    component: loadPage('404Page'),
    meta: {
      layout: 'Minimal',
    },
  },
];


---

## Assistant

This code exports an array of objects representing different routes in a Vue.js app. Each object in the `routes` array has several properties, such as `name`, `path`, `component`, and `meta`. 

The `name` property is a string that represents the name of the route. The `path` property is a string that represents the URL path of the route. The `component` property is a reference to the Vue.js component that should be displayed when the route is visited. 

The `meta` property is an object that can contain additional metadata about the route. In this case, the `meta` object has two properties: `layout` and `requiresAuth`. The `layout` property specifies which layout should be used for the route, and the `requiresAuth` property specifies whether the user must be authenticated in order to access the route.

The `beforeEnter` property is a function that is called before the route is entered. It can be used to perform checks or redirects before the route is displayed.

Finally, the `children` property is an array of objects representing child routes of the current route. Child routes are displayed inside the parent route's component, and the URL path of a child route is appended to the parent route's path.

---

## User

are the routes being lazy loaded?

---

## Assistant

It looks like the routes are being lazy-loaded, meaning that the component for each route will only be loaded when the route is visited. 

This is done using the `import()` function in the `loadPage` function, which returns a Promise that resolves with the requested module. The returned Promise is then passed as the `component` for each route.

Lazy-loading routes can improve the performance of a Vue.js app by reducing the amount of JavaScript that needs to be downloaded when the app first loads. It can also help with reducing the initial load time of the app.

---

## User

function loadPage(page) {
  return () => import(`./../views/${page}.vue`);
}

---

## Assistant

Yes, that's correct. The `loadPage` function takes a `page` parameter and returns a new function that imports the module located at `./../views/${page}.vue`.

The returned function is a "thunk", a function that wraps an expression to delay its evaluation. When the thunk is called, it returns the result of evaluating the wrapped expression. In this case, the wrapped expression is the call to `import(...)`, which returns a Promise that resolves with the requested module.

This thunk function is used as the value of the `component` property for each route. When the route is visited, the thunk function will be called and the Promise returned by `import(...)` will be resolved, loading the module for the route's component.

---

## User

is this function async?

---

## Assistant

No, the `loadPage` function is not asynchronous. It simply returns a thunk function that, when called, returns a Promise.

The thunk function itself is not asynchronous, but when it is called and the Promise returned by `import(...)` is resolved, the component module will be asynchronously loaded.

You could make the `loadPage` function asynchronous by using the `async` keyword and `await`ing the call to `import(...)`, like this:

```
async function loadPage(page) {
  const module = await import(`./../views/${page}.vue`);
  return module.default;
}
```

However, this is not necessary in this case, since the `loadPage` function only needs to return the Promise returned by `import(...)`, which will be handled by the Vue.js router when the route is visited.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
