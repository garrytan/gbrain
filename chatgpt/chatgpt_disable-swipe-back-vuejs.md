---
conversation_id: b6ad6800-d461-4009-a42b-847a6b997070
created: 2023-02-07
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 12
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Disable Swipe Back Vue.js
type: guide
updated: 2023-02-07
---

# Disable Swipe Back Vue.js

> Conversation ID: b6ad6800-d461-4009-a42b-847a6b997070
> Created: 2023-02-07T18:47:14Z
> Updated: 2023-02-07T18:47:14Z
> Messages: 12

---

## User

how can i disable the swipe back gesture on my webapp. my app is written in vue.js.  I want users to be able to scroll horizantly without accidently trigger the back button

---

## Assistant

You can disable the swipe back gesture in your Vue.js webapp by using the "beforeRouteLeave" navigation guard in your component. You can attach this guard to the component that you don't want the swipe gesture to trigger the back button. 

Here is an example:

```
beforeRouteLeave (to, from, next) {
  document.ontouchstart = e => e.preventDefault()
  next()
}
```

This will prevent default touch events, including the swipe back gesture, from being triggered in the component.

---

## User

my component route currently is:

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

how would i add the new code?

---

## Assistant

You can add the `beforeRouteLeave` navigation guard to your component by modifying the component object like this:

```
{
  name: 'Contacts',
  path: '/contacts',
  component: loadPage('Crm'),
  meta: {
    layout: 'App',
    requiresAuth: true,
    requiresSubscribe: false,
  },
  beforeRouteLeave (to, from, next) {
    document.ontouchstart = e => e.preventDefault()
    next()
  }
},
```

Now, the `beforeRouteLeave` guard will be attached to your component, and the swipe back gesture will be disabled for the component.

---

## User

i cant still swipe back

---

## Assistant

It's possible that the swipe back gesture is being handled by some other script or library, and preventing the `beforeRouteLeave` guard from working correctly. To avoid this, you can try using the following code to completely disable touch events on the page:

```
document.ontouchmove = function(event){
    event.preventDefault();
}
```

This will prevent any touch events, including swipe gestures, from being triggered on the page. Add this code inside the `beforeRouteLeave` guard. It should look like this:

```
beforeRouteLeave (to, from, next) {
  document.ontouchmove = function(event){
    event.preventDefault();
  }
  next()
}
```

---

## User

nope

---

## Assistant

If the above solutions are not working for you, another option would be to wrap the content of your component in a container element and disable scrolling for that container. For example, you could add the following CSS to your component:

```
.no-scroll {
  overflow: hidden;
}
```

And then add this class to the container element in your component template:

```
<template>
  <div class="no-scroll">
    <!-- your component content here -->
  </div>
</template>
```

This will prevent scrolling on the component and should prevent the swipe back gesture from being triggered.

---

## User

nope

---

## Assistant

I apologize for the previous solutions not working for you. If none of the previous solutions have worked, it's possible that the swipe back gesture is being handled at a higher level, such as at the browser level or by a library you are using. 

Without more information about your specific setup, it's difficult to provide a definitive solution. You may want to try reaching out to the community for further assistance or considering alternative approaches, such as using a custom back button or modifying the UI to eliminate the need for the swipe gesture altogether.

---

## User

it being handles by the operating system

---

## Assistant

In that case, it is not possible to disable the swipe back gesture at the webapp level since it is being handled by the operating system. The swipe back gesture is a common navigation feature in many mobile browsers and operating systems, and is designed to provide a convenient way for users to navigate backwards in their browsing history. 

As a result, it is not possible to disable the swipe back gesture for your webapp. You may want to consider alternative navigation options for your users, such as a custom back button or modifying the UI to eliminate the need for the swipe gesture altogether.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
