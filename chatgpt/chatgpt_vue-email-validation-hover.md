---
title: "Vue email validation hover"
type: guide
created: 2022-12-22
updated: 2022-12-22
source: chatgpt-export
conversation_id: cfbc3c6d-eac3-4de3-9184-778ea3fa77d2
message_count: 2
tags: [chatgpt, import, code]
---
# Vue email validation hover

> Conversation ID: cfbc3c6d-eac3-4de3-9184-778ea3fa77d2
> Created: 2022-12-22T20:18:54Z
> Updated: 2022-12-22T20:18:54Z
> Messages: 2

---

## User

<template>
  <div class="relative">
    <input
      class="block w-full bg-transparent px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:outline-indigo-500 focus-visible:ring-indigo-500 dark:placeholder-slate-500 sm:text-xs"
      :value="modelValue"
      :id="fieldId"
      @blur="validateEmail(modelValue)"
      autocomplete="off"
      :placeholder="placeholder"
      :aria-describedby="fieldId"
      @input="$emit('update:modelValue', $event.target.value)" />
    <div
      v-if="dataType == 'email' && modelValue.length > 0"
      class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
      <JovieSpinner v-if="loading" class="h-5 w-5 text-slate-500" />
      <CheckCircleIcon
        v-if="passesValidation"
        class="h-5 w-5 text-slate-500 dark:text-jovieDark-300"
        tooltip="Appears to be valid"
        aria-hidden="true" />
      <ExclamationCircleIcon
        v-if="errorMessage"
        tooltip="Email may be invalid"
        class="h-5 w-5 text-red-600 dark:text-red-400"
        aria-hidden="true" />
    </div>
  </div>
</template>

<script>
import JovieSpinner from '../components/JovieSpinner.vue';
import {
  ExclamationCircleIcon,
  CheckCircleIcon,
} from '@heroicons/vue/24/solid';
export default {
  components: {
    JovieSpinner,
    ExclamationCircleIcon,
    CheckCircleIcon,
  },
  data() {
    return {
      passesValidation: null,
      errorMessage: '',
    };
  },
  props: ['modelValue', 'placeholder', 'fieldId', 'dataType'],
  emits: ['update:modelValue'],
  methods: {
    async validateEmail(email) {
      this.passesValidation = false;
      this.errorMessage = '';
      this.loading = true;

      // Validate email using a regular expression
      const emailRegex =
        /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
      const isValidEmail = emailRegex.test(email);

      if (!isValidEmail) {
        this.loading = false;
        this.errorMessage = 'Email failed regex test';
      }

      // Extract the domain of the email address
      const domain = email.split('@')[1];

      // Use the fetch method to send a GET request to the Google DNS over HTTPS endpoint
      const response = await fetch(
        `https://dns.google.com/resolve?name=${domain}&type=MX`
      );
      const data = await response.json();

      if (!data.Answer) {
        this.loading = false;
        this.errorMessage = 'Email failed DNS test';
      }

      if (isValidEmail && data.Answer) {
        this.loading = false;
        this.passesValidation = true;
      }
    },
  },
};
</script>


this vue component allows you to enter an email. it then validates the email. if it fails it shows a red  exclamation mark icon. if it passes it shows a check. it works great.

but when it passes i want the user to be able to hover over the icon to reveal a small popup that shows a list of the tests and a check or x next to each to show if it passed or failed that test.

---

## Assistant

To implement the hover feature that you described, you can use the `v-tooltip` directive provided by the `v-tooltip` package.

First, you'll need to install the package by running the following command in your terminal:

```
npm install --save v-tooltip
```

Next, you'll need to import the `v-tooltip` directive and register it in your Vue component:

```
<template>
  <div class="relative">
    <input
      ...
    <div
      v-if="dataType == 'email' && modelValue.length > 0"
      class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
      <JovieSpinner v-if="loading" class="h-5 w-5 text-slate-500" />
      <CheckCircleIcon
        v-if="passesValidation"
        v-tooltip="'Appears to be valid'"
        class="h-5 w-5 text-slate-500 dark:text-jovieDark-300"
        aria-hidden="true" />
      <ExclamationCircleIcon
        v-if="errorMessage"
        v-tooltip="errorMessage"
        class="h-5 w-5 text-red-600 dark:text-red-400"
        aria-hidden="true" />
    </div>
  </div>
</template>

<script>
import JovieSpinner from '../components/JovieSpinner.vue';
import {
  ExclamationCircleIcon,
  CheckCircleIcon,
} from '@heroicons/vue/24/solid';
import Vue from 'vue';
import VTooltip from 'v-tooltip';

Vue.use(VTooltip);

export default {
  components: {
    JovieSpinner,
    ExclamationCircleIcon,
    CheckCircleIcon,
  },
  data() {
    return {
      passesValidation: null,
      errorMessage: '',
    };
  },
  props: ['modelValue', 'placeholder', 'fieldId', 'dataType'],
  emits: ['update:modelValue'],
  methods: {
    async validateEmail(email) {
      this.passesValidation = false;
      this.errorMessage = '';
      this.loading = true;

      // Validate email using a regular expression
      const emailRegex =
        /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
      const isValidEmail = emailRegex.test(email);

      if (!isValidEmail) {
        this.loading = false;
        this.errorMessage = 'Email failed regex test';
      }

      // Extract the domain of the email address

