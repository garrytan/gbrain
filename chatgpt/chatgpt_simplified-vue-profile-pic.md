---
title: "Simplified Vue Profile Pic"
type: guide
created: 2023-05-20
updated: 2023-05-20
source: chatgpt-export
conversation_id: a27cdcaf-bdb1-4d45-91c4-4172665d24ef
message_count: 2
tags: [chatgpt, import, code]
---
# Simplified Vue Profile Pic

> Conversation ID: a27cdcaf-bdb1-4d45-91c4-4172665d24ef
> Created: 2023-05-20T22:40:20Z
> Updated: 2023-05-20T22:40:43Z
> Messages: 2

---

## User

<template>
  <div :class="'h-' + height + ' w-' + height + ' flex-shrink-0'">
    <label :for="`profile_pic_url_${contact.id}`">
      <div
        v-if="loading"
        class="h-full w-full animate-pulse rounded-full bg-slate-400 ring-2 ring-slate-200 dark:bg-jovieDark-600 dark:ring-jovieDark-500"></div>
      <div v-else-if="hasProfilePic">
        <span
          class="relative inline-block rounded-full ring-2 ring-slate-200 dark:ring-jovieDark-500">
          <img
            :class="'h-full w-full rounded-full object-cover object-center'"
            :ref="`profile_pic_url_img_${contact.id}`"
            :id="`profile_pic_url_img_${contact.id}`"
            :src="contact.profile_pic_url"
            @error="imageLoadError = true"
            :alt="
              contact.full_name
                ? contact.full_name + ' Profile Picture'
                : 'Profile Picture'
            " />
          <span
            v-if="editable"
            class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block">
            <PencilIcon
              class="mx-auto h-1/2 w-1/2 items-center text-slate-400/50 dark:text-jovieDark-300" />
          </span>
        </span>
      </div>
      <span
        v-else
        class="group inline-flex h-full w-full items-center justify-center rounded-full bg-slate-400 ring-2 ring-slate-300 dark:bg-jovieDark-600 dark:ring-jovieDark-500">
        <span class="relative inline-block">
          <span
            v-if="!updatin && (contact.full_name || contact.first_name)"
            :class="[
              editable ? 'block group-hover:hidden' : '',

              height == 8
                ? 'text-xs'
                : height == 12
                ? 'text-sm'
                : height == 18
                ? 'text-xl'
                : height == 24
                ? 'text-2xl'
                : height == 32
                ? 'text-3xl'
                : height == 40
                ? 'text-4xl'
                : height == 48
                ? 'text-5xl'
                : height == 56
                ? 'text-6xl'
                : height == 64
                ? 'text-7xl'
                : 'text-xs',
            ]"
            class="font-medium capitalize leading-none text-white">
            <span
              v-if="!updating"
              class="font-medium capitalize leading-none text-white"
              >{{ intials }}</span
            >
            <span v-else class="font-medium capitalize leading-none text-white"
              >{{ progress }}%
            </span>
          </span>
          <img
            v-else
            class="rounded-full object-cover object-center"
            :class="'h-' + height + ' w-' + height"
            :ref="`profile_pic_url_img_${contact.id}`"
            :id="`profile_pic_url_img_${contact.id}`"
            :src="defaultImage"
            @error="imageLoadError = true"
            :alt="
              contact.full_name
                ? contact.full_name + ' Profile Picture'
                : 'Profile Picture'
            " />
          <span
            v-if="editable"
            class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block">
            <PencilIcon
              class="mx-auto h-1/3 w-1/3 items-center text-white/50 dark:text-jovieDark-300/50" />
          </span>
        </span>
      </span>
    </label>
    <input
      :disabled="updating || !editable"
      type="file"
      :ref="`profile_pic_url_${contact.id}`"
      @change="fileChanged($event)"
      name="profile_pic_url"
      :id="`profile_pic_url_${contact.id}`"
      style="display: none" />
  </div>
</template>

can this be more concise?

---

## Assistant

Yes, the code can be made more concise. Here's a simplified version of the code:

```html
<template>
  <div :class="'h-' + height + ' w-' + height + ' flex-shrink-0'">
    <label :for="`profile_pic_url_${contact.id}`">
      <div
        v-if="loading"
        :class="['h-full w-full animate-pulse rounded-full bg-slate-400 ring-2 ring-slate-200 dark:bg-jovieDark-600 dark:ring-jovieDark-500']"></div>
      <div v-else-if="hasProfilePic">
        <span class="relative inline-block rounded-full ring-2 ring-slate-200 dark:ring-jovieDark-500">
          <img
            :class="'h-full w-full rounded-full object-cover object-center'"
            :ref="`profile_pic_url_img_${contact.id}`"
            :id="`profile_pic_url_img_${contact.id}`"
            :src="contact.profile_pic_url"
            @error="imageLoadError = true"
            :alt="getAltText(contact.full_name)" />
          <span v-if="editable" class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block">
            <PencilIcon class="mx-auto h-1/2 w-1/2 items-center text-slate-400/50 dark:text-jovieDark-300" />
          </span>
        </span>
      </div>
      <span v-else class="group inline-flex h-full w-full items-center justify-center rounded-full bg-slate-400 ring-2 ring-slate-300 dark:bg-jovieDark-600 dark:ring-jovieDark-500">
        <span class="relative inline-block">
          <span :class="['font-medium capitalize leading-none text-white', getSizeClass(height)]">
            <span v-if="!updating">{{ intials }}</span>
            <span v-else>{{ progress }}%</span>
          </span>
          <img
            v-else
            class="rounded-full object-cover object-center"
            :class="'h-' + height + ' w-' + height"
            :ref="`profile_pic_url_img_${contact.id}`"
            :id="`profile_pic_url_img_${contact.id}`"
            :src="defaultImage"
            @error="imageLoadError = true"
            :alt="getAltText(contact.full_name)" />
          <span v-if="editable" class="mx-auto hidden h-full w-full items-center rounded-full group-hover:block">
            <PencilIcon class="mx-auto h-1/3 w-1/3 items-center text-white/50 dark:text-jovieDark-300/50" />
          </span>
        </span>
      </span>
    </label>
    <input
      :disabled="updating || !editable"
      type="file"
      :ref="`profile_pic_url_${contact.id}`"
      @change="fileChanged($event)"
      name="profile_pic_url"
      :id="`profile_pic_url_${contact.id}`"
      style="display: none" />
  </div>
</template>

<script>
export default {
  // Component properties and methods
  methods: {
    getSizeClass(height) {
      const sizes = [8, 12, 18, 24, 32, 40, 48, 56, 64];
      const size = sizes.includes(height) ? height : 8;
      return size === 8 ? 'text-xs' : `text-${size / 8}xl`;
    },
    getAltText(fullName) {
      return fullName ?
