---
title: "Vue Email Validation Component"
type: guide
created: 2022-12-22
updated: 2022-12-22
source: chatgpt-export
topic: coding-web
message_count: 8
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Vue Email Validation Component

> **Source:** ChatGPT conversation
> **Date:** 2022-12-22T21:47:26Z
> **Messages:** 8
> **Topic:** coding-web

## Question

<template>
  <div class="relative items-center">
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
      tabindex="-1"
      v-if="dataType == 'email' && modelValue.length > 0"
      class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 focus-visible:outline-none focus-visible:ring-0">
      <Popover class="relative">
        <Float placement="right-start" shift portal>
          <PopoverButton @mouseover="showValidationModal = true">
            <JovieSpinner
              v-if="validatingEmail && !passesValidation && !errorMe

## Answer

This is a Vue.js component that provides a form field for inputting an email address, and performs validation on the email address when the input field loses focus. It also has a popover that displays a list of validation checks performed on the email address when the user hovers over the validation icon.

The component uses several other components such as `Popover`, `Float`, `JovieSpinner`, `ExclamationCircleIcon`, `CheckCircleIcon`, `TransitionRoot`, and `GlassmorphismContainer`. It also has a `debounce` method that is used to limit the rate at which the `validateEmail` method is called, to avoid overloading the server with requests.

The component has several props: `modelValue`, `placeholder`, `fieldId`, and `dataType`. It also emits an event called `update:modelValue`, which updates the value of the `modelValue` prop.

The component has several data properties: `passesValidation`, `errorMessage`, `validatingEmail`, and `showValidationModal`. `passesValidation` is a boolean that indicates whether the email address is valid or not. `errorMessage` is a string that contains an error message if the email address is invalid. `validatingEmail` is a boolean that indicates whether the email address is currently being validated. `showValidationModal` is a boolean that determines whether the popover with the validation checks is displayed or not.

The component has a single method, `validateEmail`, which is called when the input field loses focus. It is responsible for performing the email validation and setting the `passesValidation`, `errorMessage`, and `validatingEmail` data properties based on the result of the validation.

## Question

extract everything inside the <Popover> tags to a new vue component called EmailValidationIcon.vue

## Answer

Here is an example of how you could extract everything inside the `<Popover>` tags to a new Vue component called `EmailValidationIcon.vue`:

```
<template>
  <Popover class="relative">
    <Float placement="right-start" shift portal>
      <PopoverButton @mouseover="showValidationModal = true">
        <JovieSpinner
          v-if="validatingEmail && !passesValidation && !errorMessage"
          tabindex="-1"
          class="h-5 w-5 text-slate-500" />
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
      </PopoverButton>
      <TransitionRoot
        :show="showValidationModal"
        enter="transition ease-out duration-100"
        enter-from="transform opacity-0 scale-95"
        enter-to="transform opacity-100 scale-100"
        leave="transition ease-in duration-75"
        leave-from="transform opacity-100 scale-100">
        <PopoverPanel static class="">
          <GlassmorphismContainer>
            <ul class="py-4">
              <li>Basic Check</li>
              <li>DNS Check</li>
              <li>Full Validation</li>
            </ul>
          </GlassmorphismContainer>
        </PopoverPanel>
      </TransitionRoot>
    </Float>
  </Popover>
</template>

<script>
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  TransitionRoot,
} from '@headlessui/vue';
import { Float } from '@headlessui-float/vue';
import JovieSpinner from '../components/JovieSpinner.vue';
import {
  ExclamationCircleIcon,
  CheckCircleIcon,
} from '@heroicons/vue/24/solid';
import GlassmorphismContainer from './GlassmorphismContainer.vue';

export default {
  components: {
    JovieSpinner,
    Float,
    Popover,
    PopoverButton,
    PopoverPanel,
    ExclamationCircleIcon,
    CheckCircleIcon,
    TransitionRoot,
    GlassmorphismContainer,
  },
  data() {
    return {
      passesValidation: null,
      errorMessage: '',
      validatingEmail: false,
      showValidationModal: false,
    };
  },
  props: ['validatingEmail', 'passesValidation', 'errorMessage'],
};
</script>
```

To use this component in the original email input field component, you can replace the content inside the `<Popover>` tags with an instance of the `EmailValidationIcon`

## Question

and now show the modified parent component with the reference to the new component

## Answer

Here is the modified parent component with a reference to the new `EmailValidationIcon` component:

```
<template>
  <div class="relative items-center">
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
      tabindex="-1"
      v-if="dataType == 'email' && modelValue.length > 0"
      class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 focus-visible:outline-none focus-visible:ring-0">
      <EmailValidationIcon
        :validatingEmail="validatingEmail"
        :passesValidation="passesValidation"
        :errorMessage="errorMessage"
      />
    </div>
  </div>
</template>

<script>
import EmailValidationIcon from './EmailValidationIcon.vue';

export default {
  components: {
    EmailValidationIcon,
  },
  data() {
    return {
      passesValidation: null,
      errorMessage: '',
      validatingEmail: false,
      showValidationModal: false,
    };
  },
  props: ['modelValue', 'placeholder', 'fieldId', 'dataType'],
  emits: ['update:modelValue'],
  created() {
    // Bind the debounced validateEmail method to the component instance
    this.validateEmail = this.debounce(this.validateEmail, 500);
  },
  methods: {
    debounce(func, wait) {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    },
    async validateEmail(email) {
      this.validatingEmail = true;
      this.passesValidation = null;
      this.errorMessage = '';
      try {
        // Perform email validation
        const validationResult = await validateEmail(email);
        this.passesValidation = validationResult.isValid;
        if (!validationResult.isValid) {
          this.errorMessage = validationResult.errorMessage;
        }
      } catch (error) {
        console.error(error);
      } finally {
        this.validatingEmail = false;
      }
    },
  },
};
</script>
```

## Question

add verbose logging to the method

 async validateEmail(email) {
      this.passesValidation = false;
      this.errorMessage = '';
      this.validatingEmail = true;

      // Validate email using a regular expression
      const emailRegex =
        /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
      const isValidEmail = emailRegex.test(email);

      if (!isValidEmail) {
        this.validatingEmail = false;
        this.errorMessage = 'Email failed regex test';
      }

      // Extract the domain of the email address
      const domain = email.split('@')[1];

      try {
        // Use the fetch method to send a GET request to the Google DNS over HTTPS endpoint
        const response = await fetch(
          `https://dns.google.com/resolve?name=${domain}&type=MX`
        );
        const data = await response.json();

        if (!data.Answer) {
          this.validatingEma

## Answer

Here is the modified `validateEmail` method with verbose logging added:

```
async validateEmail(email) {
  this.passesValidation = false;
  this.errorMessage = '';
  this.validatingEmail = true;

  console.log('Starting email validation...');

  // Validate email using a regular expression
  const emailRegex =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  const isValidEmail = emailRegex.test(email);

  console.log(`Email is ${isValidEmail ? 'valid' : 'invalid'} according to regex test.`);

  if (!isValidEmail) {
    this.validatingEmail = false;
    this.errorMessage = 'Email failed regex test';
  }

  // Extract the domain of the email address
  const domain = email.split('@')[1];

  try {
    // Use the fetch method to send a GET request to the Google DNS over HTTPS endpoint
    const response = await fetch(
      `https://dns.google.com/resolve?name=${domain}&type=MX`
    );
    const data = await response.json();

    console.log(`Email domain ${data.Answer ? 'exists' : 'does not exist'} according to DNS test.`);

    if (!data.Answer) {
      this.validatingEmail = false;
      this.errorMessage = 'Email failed DNS test';
    }

    if (isValidEmail && data.Answer) {
      this.validatingEmail = false;
      this.passesValidation = true;
    }
  } catch (error) {
    this.validatingEmail = false;
    this.errorMessage = error.message;
    console.error(error);
  }
}
```

This will log messages to the console at various points in the email validation process, so you can see what's happening as the validation is performed. The messages will indicate whether the email address passed or failed the regex and DNS tests, and will also log any errors that may occur during the validation process.
