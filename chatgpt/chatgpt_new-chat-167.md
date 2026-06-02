---
title: "New chat"
type: guide
created: 2022-12-29
updated: 2022-12-29
source: chatgpt-export
conversation_id: a86c3bf9-d0d3-445f-9ff1-794da822c7ba
message_count: 6
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: a86c3bf9-d0d3-445f-9ff1-794da822c7ba
> Created: 2022-12-29T04:53:47Z
> Updated: 2022-12-29T04:53:47Z
> Messages: 6

---

## User

<template>
  <RadioGroup v-model="selectedItems">
    <RadioGroupLabel
      v-if="label"
      class="text-base font-medium text-slate-900 dark:text-jovieDark-100"
      >{{ label }}</RadioGroupLabel
    >

    <div
      class="mx-auto mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-2 sm:gap-x-4">
      <RadioGroupOption
        as="template"
        v-for="item in items"
        :key="item.id"
        :value="item"
        v-slot="{ checked, active }">
        <div
          :class="[
            checked
              ? 'border-transparent'
              : 'border-gray-300 dark:border-jovieDark-border',
            active ? 'border-jovieDark-border ring-2 ring-indigo-500' : '',
            'relative flex cursor-pointer rounded-lg border bg-white p-4 shadow-sm focus:outline-none dark:bg-jovieDark-800',
          ]">
          <span class="flex flex-1">
            <span class="flex flex-col">
              <component
                :is="item.icon"
                class="h-6 w-6 text-gray-400 dark:text-jovieDark-200" />
              <RadioGroupLabel
                as="span"
                class="block text-sm font-medium text-slate-900 dark:text-jovieDark-100"
                >{{ item.title }}</RadioGroupLabel
              >
              <RadioGroupDescription
                as="span"
                class="mt-1 flex items-center text-sm text-slate-500 dark:text-jovieDark-400"
                >{{ item.description }}</RadioGroupDescription
              >
              <RadioGroupDescription
                as="span"
                class="mt-6 text-sm font-medium text-slate-900 dark:text-jovieDark-100"
                >{{ item.cta }}</RadioGroupDescription
              >
            </span>
          </span>
          <CheckCircleIcon
            :class="[!checked ? 'invisible' : '', 'h-5 w-5 text-indigo-600']"
            aria-hidden="true" />
          <span
            :class="[
              active ? 'border' : 'border-2',
              checked ? 'border-indigo-500' : 'border-transparent',
              'pointer-events-none absolute -inset-px rounded-lg',
            ]"
            aria-hidden="true" />
        </div>
      </RadioGroupOption>
    </div>
  </RadioGroup>
</template>

<script setup>
import { ref } from 'vue';

import {
  RadioGroup,
  RadioGroupDescription,
  RadioGroupLabel,
  RadioGroupOption,
} from '@headlessui/vue';
import { CheckCircleIcon, UserIcon, UsersIcon } from '@heroicons/vue/20/solid';
const items = [
  {
    id: 1,
    title: 'With my team',
    description: 'Collaborate with your team on a shared workspace.',
    cta: 'Try free',
    icon: 'UsersIcon',
  },
  {
    id: 2,
    title: 'For myself',
    icon: 'UserIcon',
    description: 'Use Jovie for yourself and your personal projects.',
  },
];

const selectedItems = ref(items[0]);
</script>


---

## Assistant

This code defines a Vue template with a `RadioGroup` component that contains a number of `RadioGroupOption` components, each of which has a corresponding `RadioGroupLabel` and `RadioGroupDescription`. The `RadioGroup` is bound to a `selectedItems` data property using the `v-model` directive.

The `RadioGroupOption` components are generated using a `v-for` directive that loops over an array of objects stored in the `items` data property. Each object in the `items` array represents a single radio button option with a corresponding title, description, and call-to-action (CTA) text.

The `RadioGroupOption` components also have a `v-slot` directive that provides a number of variables that can be used to customize the appearance of each option. The `checked` and `active` variables indicate whether the option is currently selected or being hovered over by the user.

The `RadioGroup` is rendered as a grid of options, with the label and description for each option displayed below an icon representing the option. The `RadioGroupLabel` and `RadioGroupDescription` components are used to display the option's title, description, and CTA text. The `CheckCircleIcon` component is used to display a checkmark next to the selected option.


---

## User

convert this to the options api

---

## Assistant

Here is an example of how you can rewrite the code to use the options API instead of a template:

```
<template>
  <RadioGroup v-model="selectedItem" :options="options" />
</template>

<script>
import { ref } from 'vue';
import { RadioGroup } from '@headlessui/vue';
import { CheckCircleIcon, UserIcon, UsersIcon } from '@heroicons/vue/20/solid';

const items = [
  {
    id: 1,
    title: 'With my team',
    description: 'Collaborate with your team on a shared workspace.',
    cta: 'Try free',
    icon: 'UsersIcon',
  },
  {
    id: 2,
    title: 'For myself',
    icon: 'UserIcon',
    description: 'Use Jovie for yourself and your personal projects.',
  },
];

const selectedItem = ref(items[0]);

const options = items.map((item) => {
  return {
    value: item,
    label: item.title,
    description: item.description,
    cta: item.cta,
    icon: item.icon,
  };
});

export default {
  data() {
    return {
      selectedItem,
      options,
    };
  },
  components: {
    RadioGroup,
    CheckCircleIcon,
    UserIcon,
    UsersIcon,
  },
};
</script>
```

This code defines a `RadioGroup` component and binds it to the `selectedItem` data property using the `v-model` directive. The options for the `RadioGroup` are provided using the `options` data property, which is an array of objects containing the label, description, CTA text, and icon for each option.

The `options` array is generated by looping over the `items` array and mapping each object to a new object with the appropriate properties. The `RadioGroup` component will automatically generate a radio button option for each object in the `options` array.


---

## User

now lets make it so we can v-model a value and checking a box will update the v-model in the parent component

---

## Assistant

To bind the `RadioGroup` to a value in the parent component, you can use the `v-model` directive in the parent template and pass the value as a prop to the `RadioGroup` component.

Here's an example of how you can do this:

```
<template>
  <!-- Parent component template -->
  <div>
    <RadioGroup v-model="selectedOption" :options="options" @input="updateSelectedOption" />
  </div>
</template>

<script>
import { ref } from 'vue';
import { RadioGroup } from '@headlessui/vue';
import { CheckCircleIcon, UserIcon, UsersIcon } from '@heroicons/vue/20/solid';

const items = [
  {
    id: 1,
    title: 'With my team',
    description: 'Collaborate with your team on a shared workspace.',
    cta: 'Try free',
    icon: 'UsersIcon',
  },
  {
    id: 2,
    title: 'For myself',
    icon: 'UserIcon',
    description: 'Use Jovie for yourself and your personal projects.',
  },
];

const selectedOption = ref(items[0]);

const options = items.map((item) => {
  return {
    value: item,
    label: item.title,
    description: item.description,
    cta: item.cta,
    icon: item.icon,
  };
});

export default {
  data() {
    return {
      selectedOption,
      options,
    };
  },
  methods: {
    updateSelectedOption(value) {
      this.selectedOption = value;
    },
  },
  components: {
    RadioGroup,
    CheckCircleIcon,
    UserIcon,
    UsersIcon,
  },
};
</script>
```

In this example, the `RadioGroup` component is bound to the `selectedOption` data property in the parent component using the `v-model` directive. The `options` data property is passed as a prop to the `RadioGroup` component, and the `updateSelectedOption` method is called when the user selects a different option in the `RadioGroup`. The `updateSelectedOption` method updates the `selectedOption` data property with the value of the selected option.

This way, whenever the user selects a different option in the `RadioGroup`, the `selectedOption` data property in the parent component will be updated, and any changes to the `selectedOption` data property will be reflected in the `RadioGroup`.



## See Also
- [[chatgpt/chatgpt_ai-chat-instrumentation-tools]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
- [[chatgpt/chatgpt_ai-chat-test]]
- [[chatgpt/chatgpt_ai-sdk-chat-development]]
- [[chatgpt/chatgpt_chat-input-specs]]
