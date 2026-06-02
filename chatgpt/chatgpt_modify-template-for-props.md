---
title: "Modify Template for Props"
type: guide
created: 2023-12-05
updated: 2023-12-05
source: chatgpt-export
conversation_id: 7a179c8b-ab26-41f5-b862-3526c668c924
message_count: 4
tags: [chatgpt, import, code]
---
# Modify Template for Props

> Conversation ID: 7a179c8b-ab26-41f5-b862-3526c668c924
> Created: 2023-12-05T22:22:25Z
> Updated: 2023-12-05T22:25:05Z
> Messages: 4

---

## User

<template>
    <button
        type="button"
        class="relative block w-full rounded-lg border-2 border-dashed border-gray-300 p-12 text-center hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
    >
        <svg
            class="mx-auto h-12 w-12 text-gray-400"
            stroke="currentColor"
            fill="none"
            viewBox="0 0 48 48"
            aria-hidden="true"
        >
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 14v20c0 4.418 7.163 8 16 8 1.381 0 2.721-.087 4-.252M8 14c0 4.418 7.163 8 16 8s16-3.582 16-8M8 14c0-4.418 7.163-8 16-8s16 3.582 16 8m0 0v14m0-4c0 4.418-7.163 8-16 8S8 28.418 8 24m32 10v6m0 0v6m0-6h6m-6 0h-6"
            />
        </svg>
        <span class="mt-2 block text-sm font-semibold text-gray-900"
            >Create a new database</span
        >
    </button>
</template>


modify this template to accept props for:
header (this would be the text)
icon (this would accept the hero icon name like "PlusIcon" as a string

---

## Assistant

Certainly, Mr. White. To modify the template to accept props for the header and icon, you can use JavaScript to pass these values as properties to the component. Here's an updated version of your template:

```html
<template>
    <button
        type="button"
        class="relative block w-full rounded-lg border-2 border-dashed border-gray-300 p-12 text-center hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
    >
        <svg
            v-if="icon === 'PlusIcon'"
            class="mx-auto h-12 w-12 text-gray-400"
            stroke="currentColor"
            fill="none"
            viewBox="0 0 48 48"
            aria-hidden="true"
        >
            <!-- PlusIcon SVG Path here -->
        </svg>
        <!-- Add additional SVGs for other icons here with their respective v-if conditions -->

        <span class="mt-2 block text-sm font-semibold text-gray-900">{{ header }}</span>
    </button>
</template>

<script>
export default {
  props: {
    header: {
      type: String,
      required: true
    },
    icon: {
      type: String,
      required: true
    }
  }
};
</script>
```

In this modification:
- Two props, `header` and `icon`, are declared in the script section.
- The `header` prop is used to dynamically set the text in the span tag.
- The `icon` prop is used in a `v-if` directive to conditionally render the appropriate SVG based on the passed icon name (e.g., "PlusIcon").
- For other icons, add additional SVG tags with their respective `v-if` conditions to match the icon names.

Remember to pass the appropriate `header` and `icon` values when using this component.

---

## User

<template>
    <button
        type="button"
        class="relative block w-full rounded-lg border-2 border-dashed border-gray-300 p-12 text-center hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
    >
        <component class="mx-auto h-6 w-6 text-gray-400" :is="icon" />
        <!-- Add additional SVGs for other icons here with their respective v-if conditions -->

        <span class="mt-2 block text-sm font-semibold text-gray-900">{{
            header
        }}</span>
    </button>
</template>

<script>
import { PlusIcon } from "@heroicons/vue/24/solid";
export default {
    components: {
        PlusIcon,
    },
    props: {
        header: {
            type: String,
            required: true,
        },
        icon: {
            type: String,
            required: true,
        },
    },
};
</script>


this is working great. now lets add options to emit an action when it's clicked

---

## Assistant

To add the functionality of emitting an action when the button is clicked, you can introduce a custom event in the Vue component. Here's how you can modify your existing template to achieve this:

```html
<template>
    <button
        @click="emitAction"
        type="button"
        class="relative block w-full rounded-lg border-2 border-dashed border-gray-300 p-12 text-center hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
    >
        <component :is="icon" class="mx-auto h-6 w-6 text-gray-400" />
        <span class="mt-2 block text-sm font-semibold text-gray-900">{{ header }}</span>
    </button>
</template>

<script>
import { PlusIcon } from "@heroicons/vue/24/solid";
export default {
    components: {
        PlusIcon,
    },
    props: {
        header: {
            type: String,
            required: true,
        },
        icon: {
            type: String,
            required: true,
        },
    },
    methods: {
        emitAction() {
            this.$emit('action');
        }
    }
};
</script>
```

In this modification:
- An `@click` directive is added to the `<button>` tag. This directive listens for click events and calls the `emitAction` method when the button is clicked.
- The `emitAction` method is defined in the `methods` section. This method uses `this.$emit` to emit a custom event named `'action'`.
- When the button is clicked, the `'action'` event is emitted. You can listen to this event in the parent component where this button component is used and define the desired action.

Remember to handle the `'action'` event in the parent component to perform the desired action when the button is clicked.


## See Also
- [[chatgpt/chatgpt_chris-voss-reply-template-2]]
- [[chatgpt/chatgpt_chris-voss-reply-template]]
- [[chatgpt/chatgpt_concise-jovie-template]]
- [[chatgpt/chatgpt_contact-page-template]]
- [[chatgpt/chatgpt_html-template-creation-tutorial]]
