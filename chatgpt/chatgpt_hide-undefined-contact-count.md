---
title: "Hide undefined contact count"
type: note
created: 2022-12-23
updated: 2022-12-23
source: chatgpt-export
conversation_id: d8a1d521-04e4-4618-a8e6-7da1c0a76cad
message_count: 4
tags: [chatgpt, import, code]
---
# Hide undefined contact count

> Conversation ID: d8a1d521-04e4-4618-a8e6-7da1c0a76cad
> Created: 2022-12-23T18:25:35Z
> Updated: 2022-12-23T18:25:35Z
> Messages: 4

---

## User

<template>
  <div class="w-full items-center px-4">
    <h1
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <component
        :is="icon"
        :class="iconColor"
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true" />
      {{ headerText + ' Contacts' }}
    </h1>
    <p v-show="contactCount" class="text-2xs font-light text-slate-600">
      {{ contactCount }}
    </p>
  </div>
</template>

<script>
import { UserGroupIcon, HeartIcon, UserIcon } from '@heroicons/vue/24/solid';
export default {
  props: ['header', 'subheader'],
  components: {
    UserGroupIcon,
    HeartIcon,
    UserIcon,
  },
  computed: {
    icon() {
      if (this.header.includes('all')) {
        return UserGroupIcon;
      } else if (this.header.includes('favourites')) {
        return HeartIcon;
      } else {
        return UserIcon;
      }
    },
    iconColor() {
      if (this.header.includes('favourites')) {
        return 'text-red-400';
      } else if (this.header.includes('archive')) {
        return 'text-blue-400';
      } else {
        return 'text-purple-400';
      }
    },
    contactCount() {
      if (this.header.includes('all')) {
        return `${this.subheader.total} Contacts`;
      } else {
        return `${this.subheader[this.header]} Contacts`;
      }
    },
    headerText() {
      if (this.header.includes('favourites')) {
        return 'Favorited';
      } else {
        return this.header;
      }
    },
  },
};
</script>

hide the contact count if the number is undefined

---

## Assistant

You can add a check for the existence of `this.contactCount` in your template. Here's how you can modify your template code to hide the contact count if it is undefined:

```
<template>
  <div class="w-full items-center px-4">
    <h1
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <component
        :is="icon"
        :class="iconColor"
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true" />
      {{ headerText + ' Contacts' }}
    </h1>
    <p v-if="contactCount" class="text-2xs font-light text-slate-600">
      {{ contactCount }}
    </p>
  </div>
</template>
```

The `v-if` directive will only render the `<p>` element if `this.contactCount` exists. If `this.contactCount` is undefined, the `<p>` element will not be rendered.


---

## User

 contactCount() {
      if (this.header.includes('all')) {
        return `${this.subheader.total} Contacts`;
      } else {
        return `${this.subheader[this.header]} Contacts`;
      }
    },

in this function if subheader.total is undefined i need the whole function to return null

---

## Assistant

To return `null` from the `contactCount` function if `this.subheader.total` is undefined, you can add a check for the existence of `this.subheader.total` before returning the string. You can do this using the `typeof` operator, which returns the type of a variable. If the variable is `undefined`, `typeof` will return `'undefined'`.

Here's how you can modify the `contactCount` function to return `null` if `this.subheader.total` is undefined:

```
contactCount() {
  if (this.header.includes('all')) {
    if (typeof this.subheader.total === 'undefined') {
      return null;
    }
    return `${this.subheader.total} Contacts`;
  } else {
    return `${this.subheader[this.header]} Contacts`;
  }
},
```

With this change, the `contactCount` function will return `null` if `this.subheader.total` is undefined, and it will return the string with the contact count if `this.subheader.total` is defined.
