---
title: "OTP Code Input Form"
type: note
created: 2023-05-10
updated: 2023-05-10
source: chatgpt-export
conversation_id: 761f41ed-0912-4dc8-84b3-0b65c9abd8ee
message_count: 2
tags: [chatgpt, import]
---
# OTP Code Input Form

> Conversation ID: 761f41ed-0912-4dc8-84b3-0b65c9abd8ee
> Created: 2023-05-10T20:27:50Z
> Updated: 2023-05-10T20:28:27Z
> Messages: 2

---

## User

<template>
  <div class="flex flex-col">
    <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
      <input
        v-for="(digit, index) in code"
        v-model="code[index]"
        @input="checkComplete($event)"
        @paste="checkComplete($event)"
        @beforeinput="checkClipboard($event)"
        :key="'digit' + (index + 1)"
        class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
        type="text"
        placeholder="0"
        :id="'digit' + index"
        pattern="[0-9]"
        maxlength="1" />
      <div class="ml-2 h-10 w-10">
        <JovieSpinner v-if="loading" class="mt-5" />
      </div>
    </div>
    <div
      v-if="code.length === 0 && !loading"
      @click="clearInputs"
      class="mr-4 flex w-full cursor-pointer justify-end text-2xs font-medium text-slate-600 opacity-50 hover:opacity-100 dark:text-jovieDark-300">
      Clear
    </div>
  </div>
</template>

<script>
import JovieSpinner from '@/components/JovieSpinner';
export default {
  components: {
    JovieSpinner,
  },
  props: {
    otpCode: {
      type: String,
      required: true,
    },
    loading: {
      type: Boolean,
      required: true,
    },
  },
  data() {
    return {
      code: ['', '', '', '', '', ''],
    };
  },
  methods: {
    focusNextInput(event) {
      const input = event.target;
      const nextInput = input.nextElementSibling;
      if (input.value && nextInput) {
        nextInput.focus();
      }
    },
    clearInputs() {
      this.code = ['', '', '', '', '', ''];
    },
    async checkComplete(event) {
      if (event.type === 'paste') {
        // Get the pasted OTP code from the clipboard
        let otpCode = await navigator.clipboard.readText();

        // Make sure the pasted OTP code is 6 digits and contains only digits
        otpCode = otpCode.slice(0, 6);
        otpCode = otpCode.replace(/\D/g, '');

        // Update the code array with the pasted OTP code if the pasted OTP code is valid
        if (otpCode.length === 6) {
          this.code = otpCode.split('');
        } else {
          // Reset the code array if the pasted OTP code is invalid
          this.clearInputs;
          // Emit an error event to inform the parent component
          this.$emit('error', 'Invalid OTP code');
        }
      } else {
        this.focusNextInput(event);
      }

      if (this.code.every((digit) => digit !== '')) {
        this.$emit('update:modelValue', this.code.join(''));
        this.$emit('complete', this.code.join(''));
      }
    },
    async checkClipboard(event) {
      // Check if the clipboard contains a valid OTP code
      let otpCode = await navigator.clipboard.readText();
      otpCode = otpCode.slice(0, 6);
      otpCode = otpCode.replace(/\D/g, '');

      if (otpCode.length === 6) {
        // Paste the OTP code into the input element
        if (document.queryCommandSupported('insertText')) {
          // Insert the OTP code with the insertText command
          document.execCommand('insertText', false, otpCode);
        } else if (document.queryCommandSupported('paste')) {
          // Insert the OTP code with the paste command
          document.execCommand('paste', false, otpCode);
        }
      } else {
        // Prevent the default paste behavior
        event.preventDefault();
      }
    },
  },
};
</script>


---

## Assistant

The code you provided appears to be a Vue.js component. It represents a form for entering a One-Time Password (OTP) code. Let me break down the structure and explain the purpose of each section:

**Template:**
The template section defines the visual structure of the component using HTML-like syntax with additional Vue.js directives.

- The component's root element is a `div` with the CSS classes "flex" and "flex-col", which enables a vertical layout for its child elements.
- Inside the root element, there is a `div` with the id "otp" and the CSS classes "mt-5", "flex", "flex-row", and "justify-center". This div contains the OTP code input fields.
  - The input fields are created using the `v-for` directive, which loops through the `code` array and generates an input element for each digit.
  - The `v-model` directive binds the input value to the corresponding element of the `code` array, allowing two-way data binding.
  - Several event listeners are used (`@input`, `@paste`, `@beforeinput`) to trigger methods when the user interacts with the input fields.
  - The input fields have various CSS classes for styling, such as setting the font, border, and background colors based on the theme (light or dark).
  - The input fields have a `type` attribute set to "text" and a `placeholder` attribute set to "0" to indicate that they expect a single-digit number as input.
  - The `pattern` attribute restricts the input to accept only digits.
  - The `maxlength` attribute limits the input length to 1.
- After the OTP code input fields, there is another `div` element with the CSS class "ml-2 h-10 w-10". This div is used to display a loading spinner (`JovieSpinner`) when the `loading` prop is set to `true`.
- Finally, there is another `div` element that appears only when the OTP code is empty and the loading spinner is not active. This div allows the user to clear the input fields by clicking on it. It has CSS classes for styling and triggers the `clearInputs` method when clicked.

**Script:**
The script section defines the component's logic using JavaScript code.

- The `import` statement is used to import the `JovieSpinner` component from a specific path.
- The `export default` statement exports the component as the default export, making it available for use in other files.
- The `props` section defines the props that the component accepts. In this case, it expects two props: `otpCode` (a string representing the OTP code) and `loading` (a boolean indicating whether a loading state is active).
- The `data` function returns an object with the component's data properties. It initializes the `code` array with six empty strings, representing the individual digits of the OTP code.
- The `methods` section contains the component's methods, which are functions that define its behavior.
  - `focusNextInput` is a method triggered when an input field receives input. It selects the next input field and sets the focus on it if it exists.
  - `clearInputs` is a method triggered when the "Clear" div is clicked. It resets the `code` array to contain six empty strings, clearing the input fields.
  - `checkComplete` is an asynchronous method triggered when an input field receives input or a paste event occurs. It checks if the code is complete and emits events accordingly. If a valid OTP code is entered, it emits an event to update the parent component's model value and another event to indicate completion.
  - `checkClipboard` is an asynchronous


## See Also
- [[chatgpt/chatgpt_vuejs-form-input-template]]
- [[chatgpt/chatgpt_input-field-html-code]]
- [[chatgpt/chatgpt_contact-form-in-nextjs]]
- [[chatgpt/chatgpt_create-new-contact-form-part1]]
- [[chatgpt/chatgpt_create-new-contact-form-part2]]
