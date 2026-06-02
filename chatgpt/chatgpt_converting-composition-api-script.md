---
title: "Converting Composition API Script"
type: note
created: 2022-12-29
updated: 2022-12-29
source: chatgpt-export
conversation_id: 035afcf7-6122-4ee7-b676-be18f8a94187
message_count: 2
tags: [chatgpt, import, code]
---
# Converting Composition API Script

> Conversation ID: 035afcf7-6122-4ee7-b676-be18f8a94187
> Created: 2022-12-29T04:58:28Z
> Updated: 2022-12-29T04:58:28Z
> Messages: 2

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
 convert the compisiton api script to the options api

---

## Assistant

Here is an example of how you can convert the script above to use the options API:

```
<template>
  <RadioGroup v-model="selectedItem" :options="options" class="mx-auto mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-2 sm:gap-x-4">
    <template v-slot:label>
      <RadioGroupLabel
        v-if="label"
        class="text-base font-medium text-slate-900 dark:text-jovieDark-100"
        >{{ label }}</RadioGroupLabel
      >
    </template>
    <template v-slot:option="{ checked, active, value }">
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
              :is="value.icon"
              class="h-6 w-6 text-gray-400 dark:text-jovieDark-200" />
            <RadioGroupLabel
              as="span"
              class="block text-sm font-medium text-slate-900 dark:text-jovieDark-100"
              >{{ value.title }}</RadioGroupLabel
            >
            <RadioGroupDescription
              as="span"
              class="mt-1 flex items-center text-sm text-slate-500 dark:text-jovieDark-400"
              >{{ value.description }}</RadioGroupDescription
            >
            <RadioGroupDescription
              as="span"
              class="mt-6 text-sm font-medium text-slate-900 dark:text-jovieDark-100"
              >{{ value.cta }}</RadioGroupDescription
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
    </template>
  </RadioGroup>
</template>

<script>
import { ref } from 'vue';

import {
  RadioGroup,
  RadioGroupDescription,
  RadioGroupLabel,
} from '@headlessui/vue';
import { CheckCircleIcon, UserIcon, UsersIcon } from '@heroicons/vue/20/solid';
const options = [
  {
    value: {
      id: 1,
      title: 'With my team',
      description: 'Collaborate
