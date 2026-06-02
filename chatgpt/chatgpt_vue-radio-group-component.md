---
conversation_id: d498da90-7f7f-4ea7-8b6e-955c9ca828c1
created: 2022-12-28
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
title: Vue Radio Group Component
type: note
updated: 2022-12-28
---

# Vue Radio Group Component

**Related:** [[coding_web_dev]]

> Conversation ID: d498da90-7f7f-4ea7-8b6e-955c9ca828c1
> Created: 2022-12-28T23:59:08Z
> Updated: 2022-12-28T23:59:08Z
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
      class="mx-auto mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-x-4">
      <RadioGroupOption
        as="template"
        v-for="item in items"
        :key="item.id"
        :value="item"
        v-slot="{ checked, active }">
        <div
          :class="[
            checked ? 'border-transparent' : 'border-gray-300',
            active ? 'border-indigo-500 ring-2 ring-indigo-500' : '',
            'relative flex cursor-pointer rounded-lg border bg-white p-4 shadow-sm focus:outline-none dark:bg-jovieDark-900',
          ]">
          <span class="flex flex-1">
            <span class="flex flex-col">
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
                >{{ item.users }}</RadioGroupDescription
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
import { CheckCircleIcon } from '@heroicons/vue/20/solid';
const items = [
        {
          id: 1,
          title: 'With my team',
          description: 'Collaborate with your team on a shared workspace.',
          users: '621 users',
        },
        {
          id: 2,
          title: 'For myself',
          description: 'Use Jovie for yourself and your personal projects.',
        },
      ],
const label = 'Choose a workspace type',


const selectedItems = ref(items[0]);
</script>


---

## Assistant

This code is defining a Vue.js template with a component called `RadioGroup` that allows a user to select one option from a list of radio buttons. The `RadioGroup` component has a `v-model` directive that binds it to the `selectedItems` reactive property.

The `RadioGroup` component has several child components: `RadioGroupLabel`, `RadioGroupOption`, and `RadioGroupDescription`. The `RadioGroupLabel` component displays a label for the group of radio buttons, and the `RadioGroupOption` component represents each individual radio button option in the group. The `RadioGroupDescription` component is used to display a description for each radio button option.

The `RadioGroupOption` component has a `v-for` directive that iterates over the `items` array, rendering a radio button for each item in the array. The `RadioGroupOption` component also has a `v-slot` directive that provides a scoped slot for customizing the rendering of the radio button option. The slot includes properties for the `checked` and `active` state of the radio button.

The `CheckCircleIcon` component is a custom component that displays a checkmark icon next to the selected radio button. The icon is only displayed if the `checked` property is `true`.

The `setup` block at the bottom of the code defines the data for the `items` array, the `label` for the radio group, and the `selectedItems` reactive property, which is initialized to the first item in the `items` array.


---

## User

anything wrong?

---

## Assistant

It is not clear from the code you provided what you are asking about. Could you please provide more context or specify what you are asking?

---

## User

are there any syntax errors

---

## Assistant

There are no syntax errors in the code you provided. The code uses a combination of Vue.js template syntax and JavaScript code in the `setup` block.

The template uses HTML-like syntax and includes Vue.js directives, such as `v-model`, `v-if`, and `v-for`, to bind data and control the rendering of the template. The `setup` block uses JavaScript syntax to define variables and functions that are used in the template.

There are also no syntax errors in the JavaScript code in the `setup` block. The block defines an array of objects called `items`, a string called `label`, and a reactive property called `selectedItems`. The `selectedItems` property is initialized to the first item in the `items` array using the `ref` function from the `vue` package.

Overall, the code appears to be well-written and free of syntax errors.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-radio-group-template]]
- [[chatgpt/chatgpt_add-prop-to-vue-component]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_blue-man-group-shows]]
- [[chatgpt/chatgpt_component-audit-and-matching]]
