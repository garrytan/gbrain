---
title: "Vue.js button template"
type: guide
created: 2022-12-28
updated: 2022-12-28
source: chatgpt-export
conversation_id: 21cc9834-f254-4ea6-a07d-21539c68bacd
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Vue.js button template

> Conversation ID: 21cc9834-f254-4ea6-a07d-21539c68bacd
> Created: 2022-12-28T22:34:24Z
> Updated: 2022-12-28T22:34:24Z
> Messages: 8

---

## User

<template>
  <button
    type="button"
    :disabled="disabled"
    @click="trackClick()"
    class="group inline-flex items-center overflow-hidden font-medium first:rounded-l-md last:rounded-r-md only-of-type:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
    :class="[
      success
        ? 'bg-green-500'
        : error
        ? 'bg-red-500'
        : disabled
        ? 'bg-slate-500'
        : '',
      //design seconday then bg color white
      design === 'secondary' ? 'bg-white' : '',
      //if toolbar then bg color white
      toolbar ? 'bg-white' : '',

      { 'py-0 px-2 text-xs': size == 'xs' },
      { 'py-1 px-2 text-sm': size == 'sm' },
      { 'py-3  px-4 text-base': size == 'base' },
      { 'py-2 px-4 text-lg': size == 'md' },
      { 'py-3 px-6 text-xl': size == 'hero' },
      {
        'border-slate-300 bg-white text-slate-600 shadow-sm hover:bg-indigo-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-30   dark:border-jovieDark-border dark:bg-jovieDark-800 dark:hover:bg-jovieDark-700  ':
          design == 'secondary',
      },
      {
        'group flex cursor-pointer items-center rounded-md p-4 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-jovieDark-800':
          design == 'toolbar',
      },
      {
        'hover:bg-indig-600 w-full font-medium text-white shadow-sm hover:bg-indigo-600  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-30':
          design == 'primary',
      },
      {
        'mt-3 flex w-full items-center justify-center rounded-md border-none bg-indigo-500 text-base font-medium text-white shadow-xl shadow-indigo-700/30 hover:bg-indigo-800 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-700 sm:mt-0 sm:ml-3 sm:w-auto sm:flex-shrink-0':
          design == 'hero',
      },
      { 'bg-red-500 text-white': design == 'danger' },
      {
        'bg-indigo-500 text-white active:bg-indigo-600': design == 'primary',
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
      role="img"
      class="h-5 w-5"
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg">
      <title>Google</title>
      <path
        d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
    <component
      v-else-if="icon"
      :is="icon"
      :class="[
        {
          'dark:group-hover:text-slate h-5 w-5 text-slate-400 group-hover:text-slate-600 dark:text-jovieDark-400 dark:group-hover:text-jovieDark-200':
            design == 'toolbar',
        },
        { 'absolute -ml-1 mr-3 h-5 w-5': design == 'secondary' },
      ]"
      aria-hidden="true" />
    <p
      v-if="text"
      class="mx-auto flex items-center text-center text-sm"
      :class="[
        { 'text-2xs': size == 'xs' },
        { 'text-xs': size == 'sm' },
        { 'sr-only': hideText },
      ]">
      {{ text }}<slot></slot>
    </p>
    <div v-if="loader" class="ml-2 transition-all">
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
  PlusCircleIcon,
  MinusCircleIcon,
  MinusIcon,
  AdjustmentsHorizontalIcon,
  PlusIcon,
  ChevronRightIcon,
} from '@heroicons/vue/24/solid';
import { XCircleIcon, CheckCircleIcon } from '@heroicons/vue/24/solid';

import JovieSpinner from '../components/JovieSpinner';

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
    NoSymbolIcon,
    PlusIcon,
    CheckCircleIcon,
    AdjustmentsHorizontalIcon,
    MinusIcon,
    PlusCircleIcon,
    MinusCircleIcon,
    ChevronRightIcon,
    JovieSpinner,
    XCircleIcon,
  },
};
</script>


---

## Assistant

This is a Vue.js template for a button component. The component has several props that can be passed to it to customize its behavior and appearance. These props include:

- `disabled`: a boolean value that determines whether the button is disabled or not
- `success`: a boolean value that determines whether the button should have a success state
- `error`: a boolean value that determines whether the button should have an error state
- `design`: a string value that determines the design of the button. Possible values are `secondary`, `toolbar`, `primary`, `hero`, `danger`, and `primary`
- `size`: a string value that determines the size of the button. Possible values are `xs`, `sm`, `base`, `md`, and `hero`
- `toolbar`: a boolean value that determines whether the button should have a toolbar design
- `rounded`: a string value that determines the rounding of the button's corners. Possible values are `right`, `left`, `top`, `bottom`, `all`, `top-left`, `top-right`, `blt`, and `br`

The template also includes a `trackClick` method that is called when the button is clicked. This method is not defined in the template, so it is likely that it is defined elsewhere in the component or app. The template also includes an `icon` prop, which determines whether the button should display an icon. If the `icon` prop is set to `'google'`, the button will display a Google icon.

---

## User

is there anything wrong with it

---

## Assistant

It is difficult to determine if there is anything wrong with this template without more context. It appears to be a well-structured and functional template for a button component in a Vue.js app. However, there may be some issues or improvements that could be made depending on the specific needs and requirements of the app.

For example, the template includes a large number of class bindings that are used to style the button based on the various props that are passed to it. While this approach allows for a high degree of customization, it can also make the template difficult to read and understand. It might be helpful to refactor the template to make use of more modular and reusable styles.

Additionally, the template includes a number of hard-coded strings that are used to determine the design and size of the button. It might be more flexible and maintainable to use constants or enums to represent these values, rather than using strings.

Overall, it is important to consider the needs and requirements of the app when evaluating the design and implementation of the template. 

---

## User

can this be more concise?

---

## Assistant

Yes, there are several ways that this template could be made more concise. Here are a few suggestions:

1. Refactor the class bindings: The template includes a large number of class bindings that are used to style the button based on its props. These class bindings can be refactored to make the template more readable and maintainable. For example, you could create a separate class for each design or size, and bind to these classes based on the values of the relevant props.

2. Use constants or enums: Instead of using hard-coded strings to represent the design and size of the button, you could define constants or enums to represent these values. This would make the template more flexible and maintainable, as you could easily add new values or change the names of existing values without having to update the template.

3. Use computed properties: You could use computed properties to simplify the logic in the template and make it more concise. For example, you could create a computed property that returns the appropriate class for the button's design, based on the value of the `design` prop. This would allow you to eliminate some of the conditional class bindings in the template.

4. Use a CSS preprocessor: You could use a CSS preprocessor, such as Sass or Less, to modularize and reuse your styles. This would allow you to define styles in a more concise and maintainable way, and would also make it easier to update the styles of the button component.

5. Consider using a UI library: Instead of building the button component from scratch, you could consider using a UI library, such as Bootstrap or Material Design, to provide a set of pre-built, customizable components. This would allow you to take advantage of the work that has already been done by the library's developers, and would also make it easier to maintain the styles and behavior of the button component.

---

## User

lets try number 1

---

## Assistant

Sure! Here is an example of how you could refactor the class bindings in the template to make it more concise:

```
<template>
  <button
    type="button"
    :disabled="disabled"
    @click="trackClick()"
    :class="[
      designClass,
      sizeClass,
      roundedClass,
      { 'success': success },
      { 'error': error }
    ]">
    <!-- button content -->
  </button>
</template>

<script>
export default {
  props: {
    disabled: Boolean,
    success: Boolean,
    error: Boolean,
    design: String,
    size: String,
    toolbar: Boolean,
    rounded: String
  },
  computed: {
    designClass() {
      if (this.success) return 'bg-green-500';
      if (this.error) return 'bg-red-500';
      if (this.disabled) return 'bg-slate-500';

      switch (this.design) {
        case 'secondary': return 'bg-white';
        case 'toolbar': return 'bg-white';
        case 'primary': return 'hover:bg-indig-600 w-full font-medium text-white shadow-sm hover:bg-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-30';
        case 'hero': return 'mt-3 flex w-full items-center justify-center rounded-md border-none bg-indigo-500 text-base font-medium text-white shadow-xl shadow-indigo-700/30 hover:bg-indigo-800 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-700 sm:mt-0 sm:ml-3 sm:w-auto sm:flex-shrink-0';
        case 'danger': return 'bg-red-500 text-white';
        case 'primary': return 'bg-indigo-500 text-white active:bg-indigo-600';
      }
    },
    sizeClass() {
      switch (this.size) {
        case 'xs': return 'py-0 px-2 text-xs';
        case 'sm': return 'py-1 px-2 text-sm';
        case 'base': return 'py-3  px-4 text-base';
        case 'md': return 'py-2 px-4 text-lg';
        case 'hero': return 'py-3 px-6 text-xl';
      }
    },
    roundedClass() {
      switch (this.rounded) {
        case 'right': return 'rounded-r-md';
        case 'left': return 'rounded-l-md';
        case 'top': return 'rounded-t-md';
        case 'bottom': return 'rounded-b-md';
        case 'all': return 'rounded-md';
        case 'top-left': return 'rounded-tl-md';
       
