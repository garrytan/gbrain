---
conversation_id: 5ffb0b0b-9153-415b-8c9f-6bf62a673313
created: 2023-01-17
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue Combobox Filtering Example
type: guide
updated: 2023-01-17
---

# Vue Combobox Filtering Example

**Related:** [[coding_web_dev]]

> Conversation ID: 5ffb0b0b-9153-415b-8c9f-6bf62a673313
> Created: 2023-01-17T23:22:41Z
> Updated: 2023-01-17T23:22:41Z
> Messages: 4

---

## User

<template>
  <Combobox v-model="selectedPerson" v-slot="{ open }">
    <ComboboxInput as="component" :is="
      class=""
      @change="query = $event.target.value"
      :displayValue="(person) => person.name" />

    <div v-show="open">
      <!--
          Using the `static` prop, the `ComboboxOptions` are always
          rendered and the `open` state is ignored.
        -->
      <ComboboxOptions static>
        <ComboboxOption
          v-for="person in filteredPeople"
          :key="person.id"
          :value="person">
          {{ person.name }}
        </ComboboxOption>
      </ComboboxOptions>
    </div>
  </Combobox>
</template>

<script setup>
import { ref, computed } from 'vue';
import {
  Combobox,
  ComboboxInput,
  ComboboxOptions,
  ComboboxOption,
} from '@headlessui/vue';

const people = [
  { id: 1, name: 'Durward Reynolds' },
  { id: 2, name: 'Kenton Towne' },
  { id: 3, name: 'Therese Wunsch' },
  { id: 4, name: 'Benedict Kessler' },
  { id: 5, name: 'Katelyn Rohan' },
];
const selectedPerson = ref(people[0]);
const query = ref('');

const filteredPeople = computed(() =>
  query.value === ''
    ? people
    : people.filter((person) => {
        return person.name.toLowerCase().includes(query.value.toLowerCase());
      })
);
</script>


---

## Assistant

This is a template written in Vue.js, a JavaScript framework for building user interfaces. The template uses the Combobox, ComboboxInput, ComboboxOptions, and ComboboxOption components from the @headlessui/vue package. The v-model directive is used to bind the selectedPerson variable to the Combobox component, and the v-slot directive is used to bind the open variable to the Combobox component. The ComboboxInput component is rendered as a component, and the displayValue prop is used to display the person's name. A computed property called filteredPeople is used to filter the people array based on the value of the query variable. The template also includes a v-for loop to iterate over the filteredPeople array and render a ComboboxOption component for each person. The filteredPeople array is displayed in the ComboboxOptions component.


---

## User

lets change people to be a more generic term so we can use this a generic component.

Then lets make it a prop with default value using the current data

---

## Assistant

Sure, we can change the `people` variable to a more generic term such as `items`. Then, we can make it a prop that can be passed to the component and set a default value using the current data. Here's an example of how it can be done:

```
<template>
  <Combobox v-model="selectedItem" v-slot="{ open }">
    <ComboboxInput as="component" :is="
      class=""
      @change="query = $event.target.value"
      :displayValue="(item) => item.name" />

    <div v-show="open">
      <ComboboxOptions static>
        <ComboboxOption
          v-for="item in filteredItems"
          :key="item.id"
          :value="item">
          {{ item.name }}
        </ComboboxOption>
      </ComboboxOptions>
    </div>
  </Combobox>
</template>

<script>
import { ref, computed } from 'vue';
import {
  Combobox,
  ComboboxInput,
  ComboboxOptions,
  ComboboxOption,
} from '@headlessui/vue';

export default {
  props: {
    items: {
      type: Array,
      default: () => [
        { id: 1, name: 'Durward Reynolds' },
        { id: 2, name: 'Kenton Towne' },
        { id: 3, name: 'Therese Wunsch' },
        { id: 4, name: 'Benedict Kessler' },
        { id: 5, name: 'Katelyn Rohan' },
      ],
    },
  },
  data() {
    const selectedItem = ref(this.items[0]);
    const query = ref('');

    const filteredItems = computed(() =>
      query.value === ''
        ? this.items
        : this.items.filter((item) => {
            return item.name.toLowerCase().includes(query.value.toLowerCase());
          })
    );
    return { selectedItem, query, filteredItems };
  },
};
</script>
```

In the above example, I changed the name of the `people` variable to `items` and made it a prop with a default value. The `default` property on the `items` prop is set to an arrow function that returns the original data, this way it will be created afresh every time the component is created. 
It's important to also update references to `people` in the rest of the code to `items`.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
