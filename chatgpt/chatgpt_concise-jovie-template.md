---
conversation_id: c933ce39-6aea-4d80-ba69-c73ab1b61537
created: 2023-05-22
links:
- '[[chatgpt-clusters/jovie_product_strategy]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Concise Jovie Template
type: note
updated: 2023-05-22
---

# Concise Jovie Template

**Related:** [[jovie_music]]

> Conversation ID: c933ce39-6aea-4d80-ba69-c73ab1b61537
> Created: 2023-05-22T20:13:54Z
> Updated: 2023-05-22T20:14:35Z
> Messages: 2

---

## User

make this more concsie

<template>
  <JovieTooltip
    v-if="!hideIfEmpty || !hide || count > 0"
    as="template"
    :tooltipText="description">
    <MenuItem class="" v-slot="{ active }">
      <router-link
        v-if="!disableRouterLink"
        @click="handleClick()"
        active-class="bg-slate-100  w-full dark:bg-jovieDark-500 rounded dark:text-jovieDark-200"
        :to="{ name: component }">
        <div
          :class="[
            active || selected
              ? 'bg-slate-100 dark:bg-jovieDark-500 dark:text-jovieDark-200 '
              : 'text-slate-900 dark:text-jovieDark-100',
            'ui-selected:outline-none focus:ring-none group flex w-full items-center justify-between rounded px-2 py-1  text-xs focus:border-none  focus:outline-none ',
          ]">
          <div class="flex w-full items-center">
            <component
              :is="icon"
              :class="`${iconColor}`"
              class="mr-2 h-3 w-3 text-slate-400 dark:text-jovieDark-400"
              aria-hidden="true" />
            {{ name }}
          </div>

          <div class="items-center rounded p-1 hover:text-slate-50">
            <span
              v-if="count"
              class="text-xs font-light text-slate-700 group-hover:text-slate-900 dark:text-jovieDark-300 dark:group-hover:text-slate-100"
              >{{ count }}</span
            >
          </div>
        </div>
      </router-link>
      <div
        v-else
        @click="handleClick()"
        active-class="bg-slate-100  w-full dark:bg-jovieDark-500 rounded dark:text-jovieDark-200"
        :to="{ name: component }">
        <div
          :class="[
            active || selected
              ? 'bg-slate-100 dark:bg-jovieDark-500 dark:text-jovieDark-200'
              : 'text-slate-900 dark:text-jovieDark-100',
            'group flex w-full items-center justify-between rounded px-2 py-1 text-xs focus:outline-none focus:ring focus:ring-violet-300',
          ]">
          <div class="flex w-full items-center">
            <component
              :is="icon"
              :class="`${iconColor}`"
              class="mr-2 h-3 w-3 text-slate-400 dark:text-jovieDark-400"
              aria-hidden="true" />
            {{ name }}
          </div>

          <div class="items-center rounded hover:text-slate-50">
            <span
              v-if="count"
              class="text-xs font-light text-slate-700 group-hover:text-slate-900 dark:text-jovieDark-300 dark:group-hover:text-slate-100"
              >{{ count }}</span
            >
          </div>
        </div>
      </div>
    </MenuItem>
  </JovieTooltip>
</template>

<script>
import { MenuItem } from '@headlessui/vue';
import JovieTooltip from './JovieTooltip.vue';
import {
  UserPlusIcon,
  SparklesIcon,
  CloudArrowUpIcon,
  GlobeAltIcon,
  CreditCardIcon,
  UserIcon,
  DocumentDuplicateIcon,
  HeartIcon,
  CogIcon,
  CakeIcon,
  LockClosedIcon,
  ArchiveBoxIcon,
} from '@heroicons/vue/24/solid';

export default {
  components: {
    MenuItem,
    JovieTooltip,
    CakeIcon,
    ArchiveBoxIcon,
    CogIcon,
    UserPlusIcon,
    DocumentDuplicateIcon,
    HeartIcon,
    SparklesIcon,
    CloudArrowUpIcon,
    GlobeAltIcon,
    LockClosedIcon,
    CreditCardIcon,
    UserIcon,
  },
  methods: {
    handleClick() {
      this.$emit('button-click');
    },
  },
  props: {
    icon: {
      type: String,
      required: true,
    },
    disableRouterLink: {
      type: Boolean,
      required: false,
      default: false,
    },
    header: {
      type: Boolean,
      required: false,
      default: false,
    },
    hideIfEmpty: {
      type: Boolean,
      required: false,
      default: false,
    },
    hide: {
      type: Boolean,
      required: false,
      default: false,
    },
    active: {
      type: Boolean,
      required: false,
      default: false,
    },
    count: {
      type: Number,
      required: false,
    },
    name: {
      type: String,
      required: true,
    },
    selected: {
      type: Boolean,
      required: false,
      default: false,
    },
    description: {
      type: String,
      required: false,
      default: null,
    },
    iconColor: {
      type: String,
      required: false,
      default: 'text-slate-400 dark:text-jovieDark-400',
    },
    disabled: {
      type: Boolean,
      required: false,
      default: false,
    },
    component: {
      type: String,
      required: false,
      default: null,
    },
  },
};
</script>


---

## Assistant

<template>
  <JovieTooltip v-if="showTooltip" as="template" :tooltipText="description">
    <MenuItem :class="menuItemClasses" v-slot="{ active }">
      <router-link v-if="!disableRouterLink" @click="handleClick()" :to="{ name: component }">
        <div :class="itemClasses">
          <div class="flex w-full items-center">
            <component :is="icon" :class="iconColorClasses" aria-hidden="true" />
            {{ name }}
          </div>
          <div class="items-center rounded p-1 hover:text-slate-50">
            <span v-if="count" class="text-xs font-light text-slate-700 group-hover:text-slate-900 dark:text-jovieDark-300 dark:group-hover:text-slate-100">{{ count }}</span>
          </div>
        </div>
      </router-link>
      <div v-else @click="handleClick()" :to="{ name: component }">
        <div :class="itemClasses">
          <div class="flex w-full items-center">
            <component :is="icon" :class="iconColorClasses" aria-hidden="true" />
            {{ name }}
          </div>
          <div class="items-center rounded hover:text-slate-50">
            <span v-if="count" class="text-xs font-light text-slate-700 group-hover:text-slate-900 dark:text-jovieDark-300 dark:group-hover:text-slate-100">{{ count }}</span>
          </div>
        </div>
      </div>
    </MenuItem>
  </JovieTooltip>
</template>

<script>
import { MenuItem } from '@headlessui/vue';
import JovieTooltip from './JovieTooltip.vue';
import { UserPlusIcon, SparklesIcon, CloudArrowUpIcon, GlobeAltIcon, CreditCardIcon, UserIcon, DocumentDuplicateIcon, HeartIcon, CogIcon, CakeIcon, LockClosedIcon, ArchiveBoxIcon } from '@heroicons/vue/24/solid';

export default {
  components: {
    MenuItem,
    JovieTooltip,
    CakeIcon,
    ArchiveBoxIcon,
    CogIcon,
    UserPlusIcon,
    DocumentDuplicateIcon,
    HeartIcon,
    SparklesIcon,
    CloudArrowUpIcon,
    GlobeAltIcon,
    LockClosedIcon,
    CreditCardIcon,
    UserIcon,
  },
  methods: {
    handleClick() {
      this.$emit('button-click');
    },
  },
  props: {
    icon: {
      type: String,
      required: true,
    },
    disableRouterLink: {
      type: Boolean,
      default: false,
    },
    header: {
      type: Boolean,
      default: false,
    },
    hideIfEmpty: {
      type: Boolean,
      default: false,
    },
    hide: {
      type: Boolean,
      default: false,
    },
    active: {
      type: Boolean,
      default: false,
    },
    count: {
      type: Number,
    },
    name: {
      type: String,
      required: true,
    },
    selected: {
      type: Boolean,
      default: false,
    },
    description: {
      type: String,
      default: null,
    },
    iconColor: {
      type: String,
      default: 'text-slate-400 dark:text-jovieDark-400',
    },
    disabled: {
      type: Boolean,
      default: false,
    },
    component: {
      type: String,
      default: null,
    },
  },
  computed: {
    showTooltip() {
      return !this.hideIfEmpty


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_admin-tools-for-jovie]]
- [[chatgpt/chatgpt_adopting-exaai-for-jovie]]
- [[chatgpt/chatgpt_agent-first-strategy-for-jovie]]
- [[chatgpt/chatgpt_ai-changelog-insights-for-jovie]]
- [[chatgpt/chatgpt_angel-investors-for-jovie]]
