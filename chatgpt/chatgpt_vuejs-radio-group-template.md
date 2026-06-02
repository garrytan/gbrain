---
conversation_id: ae0cb606-8f76-4daa-8f09-0523212fd11d
created: 2022-12-28
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js Radio Group Template
type: guide
updated: 2022-12-28
---

# Vue.js Radio Group Template

**Related:** [[coding_web_dev]]

> Conversation ID: ae0cb606-8f76-4daa-8f09-0523212fd11d
> Created: 2022-12-28T23:30:25Z
> Updated: 2022-12-28T23:30:25Z
> Messages: 4

---

## User

<template>
  <RadioGroup v-model="selectedMailingLists">
    <RadioGroupLabel class="text-base font-medium text-gray-900">Select a mailing list</RadioGroupLabel>

    <div class="mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-x-4">
      <RadioGroupOption as="template" v-for="mailingList in mailingLists" :key="mailingList.id" :value="mailingList" v-slot="{ checked, active }">
        <div :class="[checked ? 'border-transparent' : 'border-gray-300', active ? 'border-indigo-500 ring-2 ring-indigo-500' : '', 'relative flex cursor-pointer rounded-lg border bg-white p-4 shadow-sm focus:outline-none']">
          <span class="flex flex-1">
            <span class="flex flex-col">
              <RadioGroupLabel as="span" class="block text-sm font-medium text-gray-900">{{ mailingList.title }}</RadioGroupLabel>
              <RadioGroupDescription as="span" class="mt-1 flex items-center text-sm text-gray-500">{{ mailingList.description }}</RadioGroupDescription>
              <RadioGroupDescription as="span" class="mt-6 text-sm font-medium text-gray-900">{{ mailingList.users }}</RadioGroupDescription>
            </span>
          </span>
          <CheckCircleIcon :class="[!checked ? 'invisible' : '', 'h-5 w-5 text-indigo-600']" aria-hidden="true" />
          <span :class="[active ? 'border' : 'border-2', checked ? 'border-indigo-500' : 'border-transparent', 'pointer-events-none absolute -inset-px rounded-lg']" aria-hidden="true" />
        </div>
      </RadioGroupOption>
    </div>
  </RadioGroup>
</template>

<script setup>
import { ref } from 'vue'
import { RadioGroup, RadioGroupDescription, RadioGroupLabel, RadioGroupOption } from '@headlessui/vue'
import { CheckCircleIcon } from '@heroicons/vue/20/solid'

const mailingLists = [
  { id: 1, title: 'Newsletter', description: 'Last message sent an hour ago', users: '621 users' },
  { id: 2, title: 'Existing Customers', description: 'Last message sent 2 weeks ago', users: '1200 users' },
  { id: 3, title: 'Trial Users', description: 'Last message sent 4 days ago', users: '2740 users' },
]

const selectedMailingLists = ref(mailingLists[0])
</script>

---

## Assistant

This is a Vue.js template that includes a radio group component. The radio group allows users to select a single option from a list of choices.

The template uses the `v-for` directive to loop through the `mailingLists` array and render a radio button for each item in the array. Each radio button has a label and a description, and the number of users in the corresponding mailing list is also displayed. The `v-model` directive is used to bind the value of the selected radio button to the `selectedMailingLists` variable.

The `RadioGroup`, `RadioGroupDescription`, `RadioGroupLabel`, and `RadioGroupOption` components are imported from the `@headlessui/vue` library, and the `CheckCircleIcon` component is imported from the `@heroicons/vue` library. The `CheckCircleIcon` is used to display a checkmark next to the selected radio button.

The `RadioGroupOption` component is rendered using the `template` element, and the `v-slot` directive is used to pass the `checked` and `active` props to the template. The `checked` prop is a boolean that indicates whether the radio button is selected, and the `active` prop is a boolean that indicates whether the radio button is currently being hovered over or focused. These props are used to apply styling to the radio button and its label.


---

## User

rather than mailingLists lets make this a generic component we can use through out our site. change mailingLists to items. and change the const to a prop with a default option using the current object

---

## Assistant

Sure, here's how you can modify the template to make it a generic component that can be used throughout your site:

```
<template>
  <RadioGroup v-model="selectedItem">
    <RadioGroupLabel class="text-base font-medium text-gray-900">Select an item</RadioGroupLabel>

    <div class="mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-x-4">
      <RadioGroupOption as="template" v-for="item in items" :key="item.id" :value="item" v-slot="{ checked, active }">
        <div :class="[checked ? 'border-transparent' : 'border-gray-300', active ? 'border-indigo-500 ring-2 ring-indigo-500' : '', 'relative flex cursor-pointer rounded-lg border bg-white p-4 shadow-sm focus:outline-none']">
          <span class="flex flex-1">
            <span class="flex flex-col">
              <RadioGroupLabel as="span" class="block text-sm font-medium text-gray-900">{{ item.title }}</RadioGroupLabel>
              <RadioGroupDescription as="span" class="mt-1 flex items-center text-sm text-gray-500">{{ item.description }}</RadioGroupDescription>
              <RadioGroupDescription as="span" class="mt-6 text-sm font-medium text-gray-900">{{ item.users }}</RadioGroupDescription>
            </span>
          </span>
          <CheckCircleIcon :class="[!checked ? 'invisible' : '', 'h-5 w-5 text-indigo-600']" aria-hidden="true" />
          <span :class="[active ? 'border' : 'border-2', checked ? 'border-indigo-500' : 'border-transparent', 'pointer-events-none absolute -inset-px rounded-lg']" aria-hidden="true" />
        </div>
      </RadioGroupOption>
    </div>
  </RadioGroup>
</template>

<script>
import { ref } from 'vue'
import { RadioGroup, RadioGroupDescription, RadioGroupLabel, RadioGroupOption } from '@headlessui/vue'
import { CheckCircleIcon } from '@heroicons/vue/20/solid'

export default {
  name: 'RadioButtonGroup',
  props: {
    items: {
      type: Array,
      default: () => [{ id: 1, title: 'Item 1', description: 'Item 1 description', users: '621 users' }]
    }
  },
  setup(props) {
    const selectedItem = ref(props.items[0])

    return {
      selectedItem
    }
  }
}
</script>
```

In the modified template, the `RadioButtonGroup` component accepts an `items` prop that is an array of objects. Each object in the array represents a radio button in the group and has a `title`, `description`, and `users` field. The `v-for` directive is used to loop through the `items` array and render a radio button for each item.

The `RadioButtonGroup`


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-button-template-2]]
- [[chatgpt/chatgpt_vuejs-button-template]]
- [[chatgpt/chatgpt_vuejs-component-template]]
- [[chatgpt/chatgpt_vuejs-form-input-template]]
- [[chatgpt/chatgpt_vuejs-html-page-template]]
