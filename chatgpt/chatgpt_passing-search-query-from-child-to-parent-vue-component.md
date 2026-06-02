---
title: "Passing Search Query from Child to Parent Vue Component"
type: note
created: 2022-12-21
updated: 2022-12-21
source: chatgpt-export
conversation_id: c9ce3b56-4abb-4ab9-ac0d-c1b71520a12e
message_count: 2
tags: [chatgpt, import, code]
---
# Passing Search Query from Child to Parent Vue Component

> Conversation ID: c9ce3b56-4abb-4ab9-ac0d-c1b71520a12e
> Created: 2022-12-21T00:59:28Z
> Updated: 2022-12-21T00:59:28Z
> Messages: 2

---

## User

Im extracting a serchbox to a vue.js component. But this prevents me from using v-model. How can i get the search query from the input in the new component, and pass it to the parent component

---

## Assistant

To pass the search query from the child component to the parent component, you can use the `$emit` method provided by Vue.js. This method allows the child component to emit an event that the parent component can listen for and react to.

Here's an example of how you could do this:

In the child component's template, you can add an input element with a `@input` event listener that emits a custom event:

```
<template>
  <input type="text" @input="$emit('search-query', $event.target.value)" />
</template>
```

In the parent component's template, you can include the child component and bind to the custom event using the `v-on` directive:

```
<template>
  <child-component v-on:search-query="updateSearchQuery"></child-component>
</template>
```

In the parent component's script, you can define a method to handle the event and update the search query:

```
<script>
export default {
  methods: {
    updateSearchQuery(query) {
      this.searchQuery = query;
    }
  }
}
</script>
```

This way, every time the user types in the input element in the child component, the parent component will receive the updated search query and can use it as needed.

I hope this helps! Let me know if you have any questions.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
