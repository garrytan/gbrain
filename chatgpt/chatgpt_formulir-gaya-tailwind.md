---
conversation_id: 37f64f22-35a5-4f32-9f95-c062cc763863
created: 2024-02-27
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Formulir Gaya Tailwind
type: guide
updated: 2024-02-27
---

# Formulir Gaya Tailwind

**Related:** [[coding_web_dev]]

> Conversation ID: 37f64f22-35a5-4f32-9f95-c062cc763863
> Created: 2024-02-27T01:19:16Z
> Updated: 2024-02-27T01:19:46Z
> Messages: 2

---

## User

<!--
  This example requires some changes to your config:
  
  ```
  // tailwind.config.js
  module.exports = {
    // ...
    plugins: [
      // ...
      require('@tailwindcss/forms'),
    ],
  }
  ```
-->
<template>
  <div class="bg-white py-16 sm:py-24">
    <div class="mx-auto max-w-7xl sm:px-6 lg:px-8">
      <div class="relative isolate overflow-hidden bg-gray-900 px-6 py-24 shadow-2xl sm:rounded-3xl sm:px-24 xl:py-32">
        <h2 class="mx-auto max-w-2xl text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">Get notified when we’re launching.</h2>
        <p class="mx-auto mt-2 max-w-xl text-center text-lg leading-8 text-gray-300">Reprehenderit ad esse et non officia in nulla. Id proident tempor incididunt nostrud nulla et culpa.</p>
        <form class="mx-auto mt-10 flex max-w-md gap-x-4">
          <label for="email-address" class="sr-only">Email address</label>
          <input id="email-address" name="email" type="email" autocomplete="email" required="" class="min-w-0 flex-auto rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-white sm:text-sm sm:leading-6" placeholder="Enter your email" />
          <button type="submit" class="flex-none rounded-md bg-white px-3.5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Notify me</button>
        </form>
        <svg viewBox="0 0 1024 1024" class="absolute left-1/2 top-1/2 -z-10 h-[64rem] w-[64rem] -translate-x-1/2" aria-hidden="true">
          <circle cx="512" cy="512" r="512" fill="url(#759c1415-0410-454c-8f7c-9a820de03641)" fill-opacity="0.7" />
          <defs>
            <radialGradient id="759c1415-0410-454c-8f7c-9a820de03641" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 512) rotate(90) scale(512)">
              <stop stop-color="#7775D6" />
              <stop offset="1" stop-color="#E935C1" stop-opacity="0" />
            </radialGradient>
          </defs>
        </svg>
      </div>
    </div>
  </div>
</template>


use the styling of the form above to redesign the component below
<template>
  <form @submit.prevent="submitForm">
    <label for="name">Name:</label>
    <input type="text" id="name" v-model="name" required />
    <br />
    <label for="email">Email:</label>
    <input type="email" id="email" v-model="email" required />
    <br />
    <button type="submit">Submit</button>
  </form>
</template>

<script>
export default {
  data() {
    return {
      name: "",
      email: "",
    };
  },
  methods: {
    submitForm() {
      const payload = {
        name: this.name,
        email: this.email,
      };

      fetch(
        "https://script.google.com/a/macros/timwhite.co/s/AKfycby_-knV5SdSJV9_dUDOSEZW3OSnWNPF7Gt5tb5FqFyjv7aSAg-bZGjyJYbGls8CENMEVA/exec", // Replace YOUR_WEB_APP_URL with the URL of your Apps Script web app
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      )
        .then((response) => response.json())
        .then((data) => {
          alert("Form submitted successfully!");
          console.log(data);
          this.name = "";
          this.email = "";
        })
        .catch((error) => {
          console.error("Error:", error);
          alert("An error occurred while submitting the form.");
        });
    },
  },
};
</script>


---

## Assistant

To redesign your component based on the styling of the form provided, you can follow this adjusted template and script. This redesign applies the styling cues from the original example, including background colors, text colors, button styling, and overall form layout, to your Vue component. 

### Adjusted Template

```html
<template>
  <div class="bg-gray-900 py-16 sm:py-24">
    <div class="mx-auto max-w-lg px-6">
      <form @submit.prevent="submitForm" class="flex flex-col gap-y-4">
        <div class="flex flex-col">
          <label for="name" class="sr-only">Name:</label>
          <input type="text" id="name" v-model="name" required class="rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-white sm:text-sm" placeholder="Name" />
        </div>
        <div class="flex flex-col">
          <label for="email" class="sr-only">Email:</label>
          <input type="email" id="email" v-model="email" required class="rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-white sm:text-sm" placeholder="Email" />
        </div>
        <button type="submit" class="self-center rounded-md bg-white px-4 py-2.5 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Submit</button>
      </form>
    </div>
  </div>
</template>
```

### Adjusted Script

The script part remains largely the same as your functionality does not change. However, ensure that any specific class bindings or dynamic styles that interact with your form elements are updated to reflect the new structure or classes.

```javascript
<script>
export default {
  data() {
    return {
      name: "",
      email: "",
    };
  },
  methods: {
    submitForm() {
      const payload = {
        name: this.name,
        email: this.email,
      };

      fetch("https://script.google.com/a/macros/timwhite.co/s/AKfycby_-knV5SdSJV9_dUDOSEZW3OSnWNPF7Gt5tb5FqFyjv7aSAg-bZGjyJYbGls8CENMEVA/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })
      .then(response => response.json())
      .then(data => {
        alert("Form submitted successfully!");
        console.log(data);
        this.name = "";
        this.email = "";
      })
      .catch(error => {
        console.error("Error:", error);
        alert("An error occurred while submitting the form.");
      });
    },
  },
};
</script>
```

Ensure you adjust any further styles or scripts to match this new design and maintain functionality. This redesign aligns the visual aspects of your form with the first example, creating a more cohesive and modern user interface.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
