---
conversation_id: 9f819a90-21b2-461c-b192-7afc71535b5f
created: 2023-05-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js toggle switch component
type: guide
updated: 2023-05-05
---

# Vue.js toggle switch component

**Related:** [[coding_web_dev]]

> Conversation ID: 9f819a90-21b2-461c-b192-7afc71535b5f
> Created: 2023-05-05T01:23:33Z
> Updated: 2023-05-05T01:23:50Z
> Messages: 4

---

## User

<template>
  <Switch
    v-model="enabled"
    :class="[
      enabled ? 'bg-indigo-600' : 'bg-gray-200',
      'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2',
    ]">
    <span class="sr-only">Use setting</span>
    <span
      :class="[
        enabled ? 'translate-x-5' : 'translate-x-0',
        'pointer-events-none relative inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
      ]">
      <span
        :class="[
          enabled
            ? 'opacity-0 duration-100 ease-out'
            : 'opacity-100 duration-200 ease-in',
          'absolute inset-0 flex h-full w-full items-center justify-center transition-opacity',
        ]"
        aria-hidden="true">
        <svg class="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 12 12">
          <path
            d="M4 8l2-2m0 0l2-2M6 6L4 4m2 2l2 2"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round" />
        </svg>
      </span>
      <span
        :class="[
          enabled
            ? 'opacity-100 duration-200 ease-in'
            : 'opacity-0 duration-100 ease-out',
          'absolute inset-0 flex h-full w-full items-center justify-center transition-opacity',
        ]"
        aria-hidden="true">
        <svg
          class="h-3 w-3 text-indigo-600"
          fill="currentColor"
          viewBox="0 0 12 12">
          <path
            d="M3.707 5.293a1 1 0 00-1.414 1.414l1.414-1.414zM5 8l-.707.707a1 1 0 001.414 0L5 8zm4.707-3.293a1 1 0 00-1.414-1.414l1.414 1.414zm-7.414 2l2 2 1.414-1.414-2-2-1.414 1.414zm3.414 2l4-4-1.414-1.414-4 4 1.414 1.414z" />
        </svg>
      </span>
    </span>
  </Switch>
</template>

<script setup>
import { ref } from 'vue';
import { Switch } from '@headlessui/vue';

const enabled = ref(false);
</script>


---

## Assistant

This is a Vue.js component that renders a toggle switch with two states, "enabled" and "disabled". It is built using Tailwind CSS classes and the `@headlessui/vue` library for creating accessible UI components. 

The `enabled` variable is a reactive variable created using the `ref` function from Vue. It controls the state of the toggle switch and is used as the `v-model` in the `Switch` component.

The `Switch` component is a wrapper for the toggle switch, which contains two `span` elements that represent the two states of the switch. The first `span` is the inactive state, which displays a gray background and a white circle. The second `span` is the active state, which displays an indigo background and an indigo circle with a checkmark.

When the user clicks on the switch, the `enabled` variable is toggled, which updates the state of the switch and triggers any related actions or events. 

Overall, this component is a reusable and accessible way to implement a toggle switch in a Vue.js application.

---

## User

make enabled a prop

---

## Assistant

Sure! To make `enabled` a prop instead of a `ref`, we can modify the script section like this:

```
<script setup props="enabled">
import { defineProps } from 'vue';
import { Switch } from '@headlessui/vue';

const props = defineProps({
  enabled: Boolean,
});
</script>
```

With this change, `enabled` is now a prop instead of a `ref`. The `defineProps` function from Vue is used to define the props for the component. The `enabled` prop is defined with a default value of `false` and a type of `Boolean`.

Then, we can use the `enabled` prop as the `v-model` for the `Switch` component:

```
<Switch
  v-model="enabled"
  :class="[
    enabled ? 'bg-indigo-600' : 'bg-gray-200',
    'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2',
  ]">
  <!-- Rest of the switch component code here -->
</Switch>
```

Now, when using this component in a parent component, the `enabled` prop can be bound to a data property or passed in as a Boolean value:

```
<template>
  <ToggleSwitch :enabled="isToggled" />
</template>

<script>
import ToggleSwitch from './ToggleSwitch.vue';

export default {
  data() {
    return {
      isToggled: false,
    };
  },
  components: {
    ToggleSwitch,
  },
};
</script>
``` 

With this change, the parent component can now control the state of the toggle switch by passing a `Boolean` value to the `enabled` prop.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-switch-component]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_modify-vuejs-component-for-arrow-key-navigation]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part1]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part2]]
