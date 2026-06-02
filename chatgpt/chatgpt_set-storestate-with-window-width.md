---
title: "Set $store.state with Window Width"
type: note
created: 2023-06-07
updated: 2023-06-07
source: chatgpt-export
conversation_id: c873825e-49ff-411b-8091-ed2a6083a339
message_count: 2
tags: [chatgpt, import, code]
---
# Set $store.state with Window Width

> Conversation ID: c873825e-49ff-411b-8091-ed2a6083a339
> Created: 2023-06-07T16:31:23Z
> Updated: 2023-06-07T16:31:39Z
> Messages: 2

---

## User

in vue and tailwind css im building an app. i want to set a value in $store.state based on the width of the window. how can i do this

---

## Assistant

To set a value in `$store.state` based on the width of the window in a Vue.js application using Tailwind CSS, you can follow these steps:

1. Import the `mapState` and `mapMutations` helpers from the `vuex` package in your Vue component file:

```javascript
import { mapState, mapMutations } from 'vuex';
```

2. Define a computed property that watches the window width using the `window.innerWidth` property:

```javascript
computed: {
  ...mapState(['width']),
  
  updateWidth() {
    this.setWidth(window.innerWidth); // Call the mutation to update the width value
  },
},
```

3. Create a mutation in your Vuex store to update the `width` value:

```javascript
mutations: {
  setWidth(state, width) {
    state.width = width;
  },
},
```

4. Use the `mapMutations` helper to map the `setWidth` mutation to your component's methods:

```javascript
methods: {
  ...mapMutations(['setWidth']),
},
```

5. Add an event listener to the `resize` event in the component's `mounted` lifecycle hook to update the width value when the window is resized:

```javascript
mounted() {
  window.addEventListener('resize', this.updateWidth);
},
```

6. Finally, don't forget to remove the event listener when the component is destroyed to prevent memory leaks:

```javascript
beforeDestroy() {
  window.removeEventListener('resize', this.updateWidth);
},
```

With these steps, whenever the window is resized, the `width` value in `$store.state` will be updated accordingly.

Note: Make sure you have set up Vuex correctly in your Vue.js application and have a store module defined with the `width` state property.
