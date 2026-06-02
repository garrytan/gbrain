---
conversation_id: e72b9412-b8e6-4970-9d8a-a58f70ee26b7
created: 2023-05-31
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue Button Component
type: guide
updated: 2023-05-31
---

# Vue Button Component

**Related:** [[coding_web_dev]]

> Conversation ID: e72b9412-b8e6-4970-9d8a-a58f70ee26b7
> Created: 2023-05-31T14:41:39Z
> Updated: 2023-05-31T14:43:11Z
> Messages: 3

---

## User

<template>
  <button
    type="button"
    :disabled="disabled"
    @click="trackClick()"
    class="group inline-flex items-center overflow-hidden font-medium capitalize first:rounded-l-md last:rounded-r-md only-of-type:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 active:scale-95 active:shadow-none"
    :class="[
      success
        ? 'bg-green-500'
        : error
        ? 'bg-red-500'
        : disabled
        ? 'bg-slate-500'
        : '',
      //design seconday then bg color white
      design === 'secondary'
        ? 'bg-white'
        : design === 'toolbar'
        ? 'bg-white'
        : '',
      //if toolbar then bg color white

      { 'px-2 py-0 text-xs': size == 'xs' },
      { 'px-2 py-1 text-sm': size == 'sm' },
      { 'px-4  py-3 text-base': size == 'base' },
      { 'px-4 py-2 text-lg': size == 'md' },
      { 'px-6 py-3 text-xl': size == 'hero' },
      {
        'line-clamp-1  border-slate-300 bg-white text-slate-600 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed  disabled:opacity-30 dark:border-jovieDark-border   dark:bg-jovieDark-800 dark:text-jovieDark-200 dark:hover:bg-jovieDark-700  ':
          design == 'secondary',
      },
      {
        'group flex cursor-pointer items-center rounded-md  p-4 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-jovieDark-900 dark:hover:bg-jovieDark-700':
          design == 'toolbar',
      },
      {
        '  line-clamp-1 bg-indigo-500 font-medium  text-white shadow-sm hover:bg-indigo-600 focus-visible:outline-none focus-visible:ring-2  focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 active:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-slate-300':
          design == 'primary',
      },
      {
        'mt-3 flex w-full items-center justify-center rounded-md border-none bg-indigo-500 text-base font-medium text-white shadow-xl shadow-indigo-700/30 hover:bg-indigo-800 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-700 sm:ml-3 sm:mt-0 sm:w-auto sm:flex-shrink-0':
          design == 'hero',
      },
      {
        'bg-red-500 text-white dark:bg-red-500 dark:text-white':
          design == 'danger',
      },

      //add auth design
      {
        'rounded border border-slate-200 shadow-sm hover:bg-slate-50 dark:border-jovieDark-border dark:text-white dark:hover:bg-jovieDark-800':
          design === 'auth',
      },
      { 'rounded-r-md': rounded == 'right' },
      { 'rounded-l-md': rounded == 'left' },
      { 'rounded-t-md': rounded == 'top' },
      { 'rounded-b-md': rounded == 'bottom' },
      { 'rounded-md': rounded == 'all' },
      { 'rounded-tl-md': rounded == 'top-left' },
      { 'rounded-tr-md': rounded == 'top-right' },
      { 'rounded-bl-md': rounded == 'blt' },
      { 'rounded-br-md': rounded == 'br' },
    ]">
    <svg
      v-if="icon == 'google'"
      viewBox="0 0 20 20"
      class="googleLogo"
      style="
        width: 14px;
        height: 14px;
        display: block;
        fill: inherit;
        flex-shrink: 0;
        backface-visibility: hidden;
        margin-right: 6px;
      ">
      <g>
        <path
          d="M19.9996 10.2297C19.9996 9.54995 19.9434 8.8665 19.8234 8.19775H10.2002V12.0486H15.711C15.4823 13.2905 14.7475 14.3892 13.6716 15.0873V17.586H16.9593C18.89 15.8443 19.9996 13.2722 19.9996 10.2297Z"
          fill="#4285F4"></path>
        <path
          d="M10.2002 20.0003C12.9518 20.0003 15.2723 19.1147 16.963 17.5862L13.6753 15.0875C12.7606 15.6975 11.5797 16.0429 10.2039 16.0429C7.54224 16.0429 5.28544 14.2828 4.4757 11.9165H1.08301V14.4923C2.81497 17.8691 6.34261 20.0003 10.2002 20.0003Z"
          fill="#34A853"></path>
        <path
          d="M4.47227 11.9163C4.04491 10.6743 4.04491 9.32947 4.47227 8.0875V5.51172H1.08333C-0.363715 8.33737 -0.363715 11.6664 1.08333 14.4921L4.47227 11.9163Z"
          fill="#FBBC04"></path>
        <path
          d="M10.2002 3.95756C11.6547 3.93552 13.0605 4.47198 14.1139 5.45674L17.0268 2.60169C15.1824 0.904099 12.7344 -0.0292099 10.2002 0.000185607C6.34261 0.000185607 2.81497 2.13136 1.08301 5.51185L4.47195 8.08764C5.27795 5.71762 7.53849 3.95756 10.2002 3.95756Z"
          fill="#EA4335"></path>
      </g>
    </svg>
    <component
      v-else-if="icon"
      :is="icon"
      :class="[
        {
          'dark:group-hover:text-slate h-5 w-5 text-slate-400 group-hover:text-slate-600 dark:text-jovieDark-400 dark:group-hover:text-jovieDark-200':
            design == 'toolbar',
        },
        { ' mr-2 h-4 w-4': design == 'secondary' || 'primary' },
      ]"
      aria-hidden="true" />
    <p
      v-if="text"
      class="mx-auto line-clamp-1 flex items-center text-center text-sm"
      :class="[
        { 'text-2xs': size == 'xs' },
        { 'text-xs': size == 'sm' },
        { 'sr-only': hideText },
      ]">
      {{ text }}<slot></slot>
    </p>
    <div
      v-if="loader"
      enter-active-class="translate-x-2"
      leave-active-class="translate-x-2"
      class="translate-x-2 transition-all duration-300">
      <JovieSpinner class="mr-2" :spinnerColor="loaderColor" />
    </div>
    <div v-else-if="success">
      <CheckCircleIcon class="h-5 w-5 text-white transition-all" />
    </div>

    <div v-else-if="error">
      <XCircleIcon class="h-5 w-5 text-white transition-all" />
    </div>
    <div v-else></div>
  </button>
</template>

<script>
import {
  EnvelopeIcon,
  MagnifyingGlassIcon,
  NoSymbolIcon,
  UserPlusIcon,
  PlusCircleIcon,
  SparklesIcon,
  ArrowRightOnRectangleIcon,
  ArrowLeftOnRectangleIcon,
  DocumentDuplicateIcon,
  MinusCircleIcon,
  MinusIcon,
  AdjustmentsHorizontalIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PlusIcon,
  ChevronRightIcon,
  XCircleIcon,
  CheckCircleIcon,
} from '@heroicons/vue/24/solid';

import JovieSpinner from '../components/JovieSpinner.vue';

export default {
  methods: {
    trackClick() {
      window.analytics.track('Clicked Button', {
        label: this.text,
        page: this.$route.path,
      });
    },
  },
  props: {
    text: {
      type: String,
      default: null,
      required: false,
    },
    error: {
      type: String,
      default: '',
      required: false,
    },
    icon: {
      type: String,
      default: null,
      required: false,
    },
    disabled: {
      type: Boolean,
      default: false,
    },
    buttonlink: {
      type: String,
      default: null,
      required: false,
    },
    loaderPosition: {
      type: String,
      default: 'right',
      required: false,
    },
    size: {
      type: String,
      default: 'md',
    },
    loader: {
      type: Boolean,
      default: false,
    },
    loaderColor: {
      type: String,
      default: 'white',
    },
    design: {
      type: String,
      default: 'primary',
    },
    hideText: {
      type: Boolean,
      default: false,
    },
    rounded: {
      type: String,
      default: 'all',
    },
    success: {
      type: String,
      default: null,
    },
  },
  components: {
    EnvelopeIcon,
    MagnifyingGlassIcon,
    ArrowLeftIcon,
    ArrowRightIcon,
    NoSymbolIcon,
    PlusIcon,
    SparklesIcon,
    CheckCircleIcon,
    AdjustmentsHorizontalIcon,
    MinusIcon,
    PlusCircleIcon,
    UserPlusIcon,
    MinusCircleIcon,
    ChevronRightIcon,
    ArrowRightOnRectangleIcon,
    ArrowLeftOnRectangleIcon,
    JovieSpinner,
    DocumentDuplicateIcon,
    XCircleIcon,
  },
};
</script>


---

## Assistant

This is a Vue.js component template for a button. It includes various classes and conditional rendering based on the provided props. Here's a breakdown of the template:

```html
<template>
  <button
    type="button"
    :disabled="disabled"
    @click="trackClick()"
    class="group inline-flex items-center overflow-hidden font-medium capitalize first:rounded-l-md last:rounded-r-md only-of-type:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 active:scale-95 active:shadow-none"
    :class="[...]">
    <!-- SVG icon for Google -->
    <svg v-if="icon == 'google'" viewBox="0 0 20 20" class="googleLogo" style="...">
      <!-- path elements for the Google logo -->
    </svg>
    <!-- Component icon -->
    <component v-else-if="icon" :is="icon" :class="[...]"></component>
    <!-- Text content -->
    <p v-if="text" class="mx-auto line-clamp-1 flex items-center text-center text-sm" :class="[...]">{{ text }}<slot></slot></p>
    <!-- Loader spinner -->
    <div v-if="loader" enter-active-class="translate-x-2" leave-active-class="translate-x-2" class="translate-x-2 transition-all duration-300">
      <JovieSpinner class="mr-2" :spinnerColor="loaderColor" />
    </div>
    <!-- Success icon -->
    <div v-else-if="success">
      <CheckCircleIcon class="h-5 w-5 text-white transition-all" />
    </div>
    <!-- Error icon -->
    <div v-else-if="error">
      <XCircleIcon class="h-5 w-5 text-white transition-all" />
    </div>
    <!-- Empty div for no content -->
    <div v-else></div>
  </button>
</template>
```

The template defines a button element with various attributes and classes. The button can have an SVG icon (Google logo or a custom component icon) and text content. It also supports a loader spinner, success and error icons. The classes applied to the button are conditionally determined based on the provided props.

The template is accompanied by a script section that includes the component's logic. It contains a `trackClick` method for tracking button clicks and defines the component's props and components used.

Please note that this is just a template and requires the necessary dependencies and styling to be properly utilized in a Vue.js application.

---

## User

if the loader value becomes true the spinner abruptly pops up and changes the width of the button. How can i make it smoothly animate on when the loader value becomes true


**Topic:** [[chatgpt-clusters/coding_web_dev]]
