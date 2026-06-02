---
conversation_id: 2e0f7f84-dcca-44b1-8db1-7b0e5831abb1
created: 2023-06-02
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js Switch Component
type: guide
updated: 2023-06-02
---

# Vue.js Switch Component

> Conversation ID: 2e0f7f84-dcca-44b1-8db1-7b0e5831abb1
> Created: 2023-06-02T04:37:00Z
> Updated: 2023-06-02T04:38:05Z
> Messages: 4

---

## User

<template>
  <Switch
    v-model="enabled"
    :class="[
      enabled ? 'bg-slate-100' : 'bg-slate-100',
      'relative inline-flex h-6 w-16 flex-shrink-0 cursor-pointer items-center rounded border border-transparent transition-colors duration-300 ease-in-out focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-slate-600 focus-visible:ring-offset-2',
    ]">
    <Bars4Icon class="mx-auto h-5 w-4 text-slate-500 dark:text-jovieDark-100" />

    <span class="sr-only">Board view</span>
    <span
      aria-hidden="true"
      :class="[
        enabled ? '-translate-x-8' : 'translate-x-0',
        'pointer-events-none z-10 inline-block h-6 w-8 transform items-center justify-center rounded border border-slate-200  bg-white px-1 shadow ring-0 transition duration-200 ease-in-out dark:border-jovieDark-border',
      ]">
      <Bars4Icon
        v-if="enabled"
        class="mx-auto h-5 w-4 text-slate-600 dark:text-jovieDark-100" />
      <Squares2X2Icon
        v-else
        class="mx-auto h-5 w-4 text-slate-600 dark:text-jovieDark-100" />
    </span>
    <Squares2X2Icon
      class="absolute z-0 mx-auto ml-10 h-5 w-4 text-slate-500 dark:text-jovieDark-100" />
  </Switch>
</template>

<script setup>
import JovieTooltip from './JovieTooltip.vue';
import { Squares2X2Icon, Bars4Icon } from '@heroicons/vue/20/solid';
import { ref } from 'vue';
import { Switch } from '@headlessui/vue';

const enabled = ref(false);
</script>
<script>
export default {
  components: {
    JovieTooltip,
    Squares2X2Icon,
    Bars4Icon,
    Switch,
  },
  setup() {
    return {
      enabled,
    };
  },
};
</script>


---

## Assistant

The code you provided is a Vue.js component template. It consists of a switch component that toggles between two different icons (Squares2X2Icon and Bars4Icon) based on the value of the "enabled" variable. Here's a breakdown of the template:

- The template tag is the root element of the component.
- Inside the template, there is a Switch component that is bound to the "enabled" variable using the v-model directive. This means that the "enabled" variable controls the state of the switch.
- The Switch component has a CSS class binding using the :class directive. It applies different classes based on the value of "enabled" to change the background color and other styles of the switch.
- Inside the Switch component, there is a Bars4Icon component, which represents an icon. It is conditionally rendered based on the value of "enabled" using the v-if and v-else directives.
- There is a span element that acts as a slider for the switch. It has a CSS class binding that applies different classes based on the value of "enabled" to change its position and appearance.
- Inside the span element, there are two icons (Bars4Icon and Squares2X2Icon) that are conditionally rendered based on the value of "enabled".
- Lastly, there is an absolute positioned Squares2X2Icon that represents an icon. It is always visible and positioned on the right side of the switch.

The script section consists of two parts: the "script setup" and "script" blocks. The "script setup" block is used for initializing variables, importing components, and configuring the component. In this case, it imports the JovieTooltip component, Squares2X2Icon and Bars4Icon icons from a library, and defines the "enabled" variable as a reactive reference using the ref() function.

The "script" block exports an object that defines the component's behavior and registers the imported components (JovieTooltip, Squares2X2Icon, Bars4Icon, and Switch) as child components. The setup() method is used to provide the data and methods to the component.

Overall, this component represents a switch with two different icons that change based on the value of the "enabled" variable.

---

## User

this is the ViewToggle.vue component. I want to be able to use it like this:

<ViewToggle v-model=enabled />

How can i set this up to accept the v-model on the parent level.

---

## Assistant

To set up the ViewToggle component to accept the v-model directive on the parent level, you need to modify the component and use the `emit()` function to handle the two-way binding. Here's an updated version of the ViewToggle.vue component:

```html
<template>
  <Switch
    :modelValue="enabled"
    @update:modelValue="enabled = $event"
    :class="[
      enabled ? 'bg-slate-100' : 'bg-slate-100',
      'relative inline-flex h-6 w-16 flex-shrink-0 cursor-pointer items-center rounded border border-transparent transition-colors duration-300 ease-in-out focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-slate-600 focus-visible:ring-offset-2',
    ]">
    <!-- The rest of your component template -->
  </Switch>
</template>

<script setup>
import JovieTooltip from './JovieTooltip.vue';
import { Squares2X2Icon, Bars4Icon } from '@heroicons/vue/20/solid';
import { ref, watch } from 'vue';
import { Switch } from '@headlessui/vue';

const enabled = ref(false);

watch(enabled, (value) => {
  // Emit the updated value of `enabled` using the `update:modelValue` event
  emit('update:modelValue', value);
});
</script>

<script>
export default {
  components: {
    JovieTooltip,
    Squares2X2Icon,
    Bars4Icon,
    Switch,
  },
  props: {
    modelValue: {
      type: Boolean,
      required: true,
    },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const enabled = ref(props.modelValue);

    watch(enabled, (value) => {
      // Emit the updated value of `enabled` using the `update:modelValue` event
      emit('update:modelValue', value);
    });

    return {
      enabled,
    };
  },
};
</script>
```

Here's what has been modified:

1. In the template section, we bind the `modelValue` prop to the `enabled` variable using `:modelValue="enabled"`.
2. We listen for the `update:modelValue` event on the Switch component and update the `enabled` variable accordingly using `@update:modelValue="enabled = $event"`.
3. In the `script setup` block, we import the `watch` function from Vue and use it to watch changes to the `enabled` variable. Whenever the value changes, we emit the updated value using the `update:modelValue` event using `emit('update:modelValue', value)`.
4. In the `script` block, we add a `props` object to define the `modelValue` prop with the appropriate type and make it required.
5. We add an `emits` array to define the events that the component can emit. In this case, we have `['update:modelValue']`.
6. Inside the `setup` function, we initialize the `enabled` variable with the value of the `modelValue` prop passed from the parent component.
7. We also add a watcher to the `enabled` variable to emit the updated value when it changes, just like in the `script setup` block.

By making these changes, you can now use the ViewToggle component with the `v-model` directive on the parent level, like this:

```html
<template>
  <ViewToggle v-model="enabled" />
</template>

<script>
export default {
  data() {
    return {
      enabled: false,
    };
  },
};
</script>
```

Now, the `enabled` property in the


**Topic:** [[chatgpt-clusters/coding_web_dev]]
