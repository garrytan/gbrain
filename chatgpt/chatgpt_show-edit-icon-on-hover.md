---
title: "Show edit icon on hover"
type: note
created: 2022-12-24
updated: 2022-12-24
source: chatgpt-export
conversation_id: 02d6fa70-9b4a-4a05-acb6-21e7b6d17d35
message_count: 2
tags: [chatgpt, import, code]
---
# Show edit icon on hover

> Conversation ID: 02d6fa70-9b4a-4a05-acb6-21e7b6d17d35
> Created: 2022-12-24T00:20:42Z
> Updated: 2022-12-24T00:20:42Z
> Messages: 2

---

## User

<template>
  <div class="h-8 w-8 flex-shrink-0">
    <div class="rounded-full bg-slate-400 p-0.5 dark:bg-jovieDark-600">
      <div class="rounded-full bg-white p-0 dark:bg-jovieDark-900">
        <img
          v-if="creator.profile_pic_url"
          class="rounded-full object-cover object-center"
          :src="creator.profile_pic_url"
          @error="setDefaultImage"
          alt="Profile Image" />
        <template v-else>
          <img
            class="rounded-full object-cover object-center"
            :src="defaultImage"
            alt="Default profile image" />
        </template>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    creator: {
      type: Object,
      required: true,
    },
  },
  data() {
    return {
      defaultImage: this.asset('img/noimage.webp'),
    };
  },
  methods: {
    setDefaultImage() {
      this.creator.profile_pic_url = this.defaultImage;
    },
  },
};
</script>
accept a prop for editable. if its true then show an edit icon when you hover the image

---

## Assistant

To show an edit icon when hovering over the image, you can use the `v-bind` directive to bind the `style` attribute to a computed property that adds a `display` property with a value of `none` or `block` based on the value of the `editable` prop. You can also use the `@mouseover` and `@mouseout` event listeners to toggle the value of the computed property.

Here's an example of how you can implement this:

```
<template>
  <div class="h-8 w-8 flex-shrink-0 relative" @mouseover="showEditIcon = true" @mouseout="showEditIcon = false">
    <div class="rounded-full bg-slate-400 p-0.5 dark:bg-jovieDark-600">
      <div class="rounded-full bg-white p-0 dark:bg-jovieDark-900">
        <img
          v-if="creator.profile_pic_url"
          class="rounded-full object-cover object-center"
          :src="creator.profile_pic_url"
          @error="setDefaultImage"
          alt="Profile Image" />
        <template v-else>
          <img
            class="rounded-full object-cover object-center"
            :src="defaultImage"
            alt="Default profile image" />
        </template>
      </div>
    </div>
    <template v-if="editable">
      <div v-bind:style="{ display: editIconDisplay }" class="absolute top-0 right-0 m-2">
        <i class="fas fa-edit text-2xl text-gray-500 hover:text-gray-700"></i>
      </div>
    </template>
  </div>
</template>

<script>
export default {
  props: {
    creator: {
      type: Object,
      required: true,
    },
    editable: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      defaultImage: this.asset('img/noimage.webp'),
      showEditIcon: false,
    };
  },
  computed: {
    editIconDisplay() {
      return this.showEditIcon && this.editable ? 'block' : 'none';
    },
  },
  methods: {
    setDefaultImage() {
      this.creator.profile_pic_url = this.defaultImage;
    },
  },
};
</script>
```

In the template, the `div` element with the `fa-edit` icon has its `style` attribute bound to the computed property `editIconDisplay`, which determines whether to show the icon or not based on the value of `showEditIcon` and `editable`. The `@mouseover` and `@mouseout` event listeners toggle the value of `showEditIcon` when the mouse enters or leaves the element.


**Topic:** [[chatgpt-clusters/design_ux]]
