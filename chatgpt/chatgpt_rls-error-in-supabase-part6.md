
Mr. White, in Nuxt 3 you typically don’t have a default `@/stores` alias unless you’ve added it yourself or are using Nuxt’s [auto-imported stores](https://nuxt.com/docs/guide/directory-structure/stores). Here are some ways to fix the error:

---

## 1. Use Nuxt’s Built-In Stores Folder (Auto Import)

In Nuxt 3, you can place your store in a file like `/stores/user.ts` (or `.js`). For example:

```ts
// /stores/user.ts
import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', {
  state: () => ({
    height: '',
    unitPreference: 'imperial',
    birthday: '',
  }),
  actions: {
    updateMetrics(metrics) {
      this.height = metrics.height
      this.unitPreference = metrics.unitPreference
      this.birthday = metrics.birthday
    }
  }
})
```

Because Nuxt has auto-import for Pinia stores in the `/stores` folder, **you don’t need a custom alias** or even a manual import path. You can simply use `useUserStore()` anywhere in your components/composables:

```vue
<script setup>
const userStore = useUserStore()
// Now userStore is available, no manual import needed
</script>
```

If you prefer a manual import, you can do:

```js
import { useUserStore } from '~/stores/user'
```

*(Note the `~` alias that Nuxt uses by default, not `@`.)*

---

## 2. Configure Your Own `@/stores` Alias

If you specifically want `@/stores/user`, you’ll need to ensure your **tsconfig.json** (or **jsconfig.json**) and **nuxt.config.ts** are set up for that alias.

1. **Install `vite-tsconfig-paths`:**

   ```bash
   npm install vite-tsconfig-paths --save-dev
   ```

2. **Configure tsconfig.json:**

   ```jsonc
   // tsconfig.json
   {
     "compilerOptions": {
       "baseUrl": ".",
       "paths": {
         "@/*": ["./*"]    // for @/<anything> => <root>/* 
       }
     }
   }
   ```

3. **Update nuxt.config.ts:**

   ```ts
   import tsconfigPaths from 'vite-tsconfig-paths'

   export default defineNuxtConfig({
     // ...
     vite: {
       plugins: [tsconfigPaths()]
     }
   })
   ```

After this, `import { useUserStore } from '@/stores/user'` should resolve properly, **provided** that the file is actually at `./stores/user.(js|ts)` from your project root.

---

## 3. Use Relative Paths

Finally, if you just want to get rid of the error without aliasing, switch to a relative import path in `UpdateUserMetrics.vue`:

```diff
- import { useUserStore } from '@/stores/user'
+ import { useUserStore } from '../stores/user'
```

*(Adjust `../` as needed depending on your folder structure.)*

---

### Summary

- **Recommended for Nuxt 3:** Use the built-in auto-import by placing your store in `/stores/user.ts` and simply calling `useUserStore()` in your components without a manual import.
- If you do want manual imports with `@/...`, configure the alias in **tsconfig.json** and enable it via `vite-tsconfig-paths` in your **nuxt.config.ts**.
- Or just use a relative path like `../stores/user` to avoid alias issues altogether.

Once you’ve done one of these approaches, your `UpdateUserMetrics.vue` component should compile without the “Failed to resolve import” error.


I already have a useUserStore.js file

// ~/composables/useUserStore.js
import { useState } from '#app'

export function useUserStore() {
  return useState('userData', () => ({
    firstName: '',         // First name
    lastName: '',          // Last name
    birthday: null,        // ISO date string (YYYY-MM-DD) or null if not set
    gender: '',            // 'male' or 'female'
    currentBF: null,       // Body fat percentage (under 100)
    currentWeight: null,   // Weight in kgs
    theme: 'light'         // Theme mode: 'light' or 'dark'
  }))
}

Its in the compostables file



Mr. White, with a **Nuxt 3** setup, here’s what you need to know:

1. **Composables Auto-Import**  
   - If you name your file `useUserStore.js` (or `.ts`) and place it in the `composables/` folder, Nuxt 3 will **auto-import** it by default.  
   - In a Vue component, you can call `useUserStore()` directly without importing:

     ```vue
     <script setup>
     const userData = useUserStore()
     // userData.value => { firstName: '', lastName: '', ... }
     </script>
     ```

2. **Manual Import (Optional)**  
   - If you prefer explicit imports, use the `~` alias Nuxt provides:
     ```js
     import { useUserStore } from '~/composables/useUserStore'

     export default {
       setup() {
         const userData = useUserStore()
         // ...
       }
     }
     ```
   - This works as long as your file is actually at `./composables/useUserStore.js` from your project root.

3. **Your Existing File**  
   - Your file `useUserStore.js` in `composables` already looks good:
     ```js
     // ~/composables/useUserStore.js
     import { useState } from '#app'

     export function useUserStore() {
       return useState('userData', () => ({
         firstName: '',
         lastName: '',
         birthday: null,
         gender: '',
         currentBF: null,
         currentWeight: null,
         theme: 'light'
       }))
     }
     ```
   - Nuxt’s auto-import or the `~/composables/...` path will both work fine with this.

### Using it in a Vue File

Here’s a quick example of a component referencing your composable:

```vue
<template>
  <div>
    <h2 class="text-xl font-semibold">User Data</h2>
    <p>Name: {{ userData.firstName }} {{ userData.lastName }}</p>
    <p>Birthday: {{ userData.birthday }}</p>
    <p>Theme: {{ userData.theme }}</p>
  </div>
</template>

<script setup>
const userData = useUserStore()

// Example: update user data on mount
onMounted(() => {
  userData.firstName = 'Tim'
  userData.lastName = 'White'
  userData.birthday = '1991-04-05'
  userData.theme = 'dark'
})
</script>
```

That’s all you need for the composable to work in a Nuxt 3 app. If you still encounter “module not found” issues, double-check:

- Your file name and path are correct (`/composables/useUserStore.js`).  
- You don’t have an extra alias in your code (like `@/stores/user`)—Nuxt uses `~/` or auto-import for composables.


So now update my updateusermetrics.vue component to use that


Below is your updated **UpdateUserMetrics.vue** component. The only change is the import path for your composable – now using Nuxt’s default alias for composables:

```vue
<template>
  <form class="space-y-12" @submit.prevent="saveMetrics">
    <div class="grid grid-cols-1 gap-x-8 gap-y-10 border-b border-gray-900/10 pb-12 md:grid-cols-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900">User Metrics</h2>
        <p class="mt-1 text-sm text-gray-600">
          Update your height, unit preference, and birthday.
        </p>
      </div>
      <div class="grid max-w-2xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
        <!-- Height Field -->
        <div class="sm:col-span-3">
          <label for="height" class="block text-sm font-medium text-gray-900">Height</label>
          <div class="mt-2">
            <input
              type="number"
              name="height"
              id="height"
              v-model="height"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
              placeholder="Enter your height"
            />
          </div>
        </div>

        <!-- Unit Preference Field -->
        <div class="sm:col-span-3">
          <label for="unit" class="block text-sm font-medium text-gray-900">Unit Preference</label>
          <div class="mt-2">
            <select
              id="unit"
              name="unit"
              v-model="unitPreference"
              class="block w-full rounded-md bg-white py-1.5 pl-3 pr-8 text-base text-gray-900 outline outline-1 outline-gray-300 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            >
              <option value="imperial">Imperial</option>
              <option value="metric">Metric</option>
            </select>
          </div>
        </div>

        <!-- Birthday Field -->
        <div class="sm:col-span-3">
          <label for="birthday" class="block text-sm font-medium text-gray-900">Birthday</label>
          <div class="mt-2">
            <input
              type="date"
              name="birthday"
              id="birthday"
              v-model="birthday"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <button type="button" class="text-sm font-semibold text-gray-900" @click="cancelUpdate">
        Cancel
      </button>
      <button
        type="submit"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
      >
        Save
      </button>
    </div>
  </form>
</template>

<script setup>
import { ref } from "vue";
// Update the import path to point to your composable in the composables folder
import { useUserStore } from "~/composables/useUserStore";

// Pull initial data from the store
const userStore = useUserStore();
const height = ref(userStore.value.height || "");
const unitPreference = ref(userStore.value.unitPreference || "imperial");
const birthday = ref(userStore.value.birthday || "");

function saveMetrics() {
  // Update the store with the new values; you may also trigger an API call here
  userStore.value = {
    ...userStore.value,
    height: height.value,
    unitPreference: unitPreference.value,
    birthday: birthday.value,
  };
  // Optionally, show a success message
}

function cancelUpdate() {
  // Reset inputs to the values from the store
  height.value = userStore.value.height || "";
  unitPreference.value = userStore.value.unitPreference || "imperial";
  birthday.value = userStore.value.birthday || "";
}
</script>
```

### Notes

- The import now uses `~/composables/useUserStore` so that Nuxt resolves it correctly.
- Since your `useUserStore()` returns a state via Nuxt’s `useState()`, we reference its value via `userStore.value`.
- Adjust any further logic as needed based on your store implementation.

This updated component should now correctly pull and update user metrics using your existing composable.


Update the code


Below is your updated **UpdateUserMetrics.vue** component that now uses your composable from the composables folder. It also directly updates the reactive state returned by your store (via useState), ensuring that the height, unit preference, and birthday fields are properly saved and reset.

I'll now apply the following changes:
- Change the import from `@/stores/user` to `~/composables/useUserStore`
- Use `userStore.value` since your composable uses Nuxt’s useState.
- Update the save and cancel functions accordingly.

Let’s apply these changes:

<details>
  <summary>Updated UpdateUserMetrics.vue</summary>

```vue
<template>
  <form class="space-y-12" @submit.prevent="saveMetrics">
    <div class="grid grid-cols-1 gap-x-8 gap-y-10 border-b border-gray-900/10 pb-12 md:grid-cols-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900">User Metrics</h2>
        <p class="mt-1 text-sm text-gray-600">
          Update your height, unit preference, and birthday.
        </p>
      </div>
      <div class="grid max-w-2xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
        <!-- Height Field -->
        <div class="sm:col-span-3">
          <label for="height" class="block text-sm font-medium text-gray-900">Height</label>
          <div class="mt-2">
            <input
              type="number"
              name="height"
              id="height"
              v-model="height"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
              placeholder="Enter your height"
            />
          </div>
        </div>

        <!-- Unit Preference Field -->
        <div class="sm:col-span-3">
          <label for="unit" class="block text-sm font-medium text-gray-900">Unit Preference</label>
          <div class="mt-2">
            <select
              id="unit"
              name="unit"
              v-model="unitPreference"
              class="block w-full rounded-md bg-white py-1.5 pl-3 pr-8 text-base text-gray-900 outline outline-1 outline-gray-300 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            >
              <option value="imperial">Imperial</option>
              <option value="metric">Metric</option>
            </select>
          </div>
        </div>

        <!-- Birthday Field -->
        <div class="sm:col-span-3">
          <label for="birthday" class="block text-sm font-medium text-gray-900">Birthday</label>
          <div class="mt-2">
            <input
              type="date"
              name="birthday"
              id="birthday"
              v-model="birthday"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <button type="button" class="text-sm font-semibold text-gray-900" @click="cancelUpdate">
        Cancel
      </button>
      <button
        type="submit"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
      >
        Save
      </button>
    </div>
  </form>
</template>

<script setup>
import { ref } from "vue";
// Update the import path to use your composable in the composables folder
import { useUserStore } from "~/composables/useUserStore";

// Pull initial data from the store (which is a reactive state via useState)
const userStore = useUserStore();
const height = ref(userStore.value.height || "");
const unitPreference = ref(userStore.value.unitPreference || "imperial");
const birthday = ref(userStore.value.birthday || "");

// Save metrics by updating the store's reactive state
function saveMetrics() {
  userStore.value = {
    ...userStore.value,
    height: height.value,
    unitPreference: unitPreference.value,
    birthday: birthday.value,
  };
  // Optionally, show a success message or trigger an API update here.
}

// Reset fields to the current values from the store
function cancelUpdate() {
  height.value = userStore.value.height || "";
  unitPreference.value = userStore.value.unitPreference || "imperial";
  birthday.value = userStore.value.birthday || "";
}
</script>
```

</details>

This updated component now correctly uses your composable from the `composables` folder and updates the user state accordingly.


Lets improve this component to have clear indication of whats happening when data is loading or being submitted. Use clean modern design in tailwind. Switch the units to a toggle from tailwind ui

liek:
<template>
  <SwitchGroup as="div" class="flex items-center justify-between">
    <span class="flex grow flex-col">
      <SwitchLabel as="span" class="text-sm/6 font-medium text-gray-900" passive>Available to hire</SwitchLabel>
      <SwitchDescription as="span" class="text-sm text-gray-500">Nulla amet tempus sit accumsan. Aliquet turpis sed sit lacinia.</SwitchDescription>
    </span>
    <Switch v-model="enabled" :class="[enabled ? 'bg-indigo-600' : 'bg-gray-200', 'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2']">
      <span aria-hidden="true" :class="[enabled ? 'translate-x-5' : 'translate-x-0', 'pointer-events-none inline-block size-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out']" />
    </Switch>
  </SwitchGroup>
</template>

<script setup>
import { ref } from 'vue'
import { Switch, SwitchDescription, SwitchGroup, SwitchLabel } from '@headlessui/vue'

const enabled = ref(false)
</script>


Below is the updated **UpdateUserMetrics.vue** component. It now:

- Uses a headlessui Switch toggle for unit preference (with imperial as default).
- Displays a loading spinner in the Save button while the form is being submitted.
- Disables inputs during submission for a cleaner UX.

```vue
<template>
  <form class="space-y-12" @submit.prevent="saveMetrics">
    <div class="grid grid-cols-1 gap-x-8 gap-y-10 border-b border-gray-900/10 pb-12 md:grid-cols-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900">User Metrics</h2>
        <p class="mt-1 text-sm text-gray-600">
          Update your height, unit preference, and birthday.
        </p>
      </div>
      <div class="grid max-w-2xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
        <!-- Height Field -->
        <div class="sm:col-span-3">
          <label for="height" class="block text-sm font-medium text-gray-900">Height</label>
          <div class="mt-2">
            <input
              type="number"
              name="height"
              id="height"
              v-model="height"
              :disabled="isSubmitting"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
              placeholder="Enter your height"
            />
          </div>
        </div>

        <!-- Unit Preference Toggle -->
        <div class="sm:col-span-3">
          <SwitchGroup as="div" class="flex items-center justify-between">
            <SwitchLabel as="span" class="text-sm font-medium text-gray-900" passive>
              Unit Preference
            </SwitchLabel>
            <Switch
              v-model="isMetric"
              :disabled="isSubmitting"
              :class="[isMetric ? 'bg-indigo-600' : 'bg-gray-200', 'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2']"
            >
              <span
                aria-hidden="true"
                :class="[isMetric ? 'translate-x-5' : 'translate-x-0', 'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out']"
              />
            </Switch>
          </SwitchGroup>
        </div>

        <!-- Birthday Field -->
        <div class="sm:col-span-3">
          <label for="birthday" class="block text-sm font-medium text-gray-900">Birthday</label>
          <div class="mt-2">
            <input
              type="date"
              name="birthday"
              id="birthday"
              v-model="birthday"
              :disabled="isSubmitting"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <button
        type="button"
        class="text-sm font-semibold text-gray-900"
        @click="cancelUpdate"
        :disabled="isSubmitting"
      >
        Cancel
      </button>
      <button
        type="submit"
        :disabled="isSubmitting"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
      >
        <template v-if="isSubmitting">
          <svg
            class="animate-spin inline h-5 w-5 mr-2 text-white"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8z"
            ></path>
          </svg>
          Saving...
        </template>
        <template v-else>
          Save
        </template>
      </button>
    </div>
  </form>
</template>

<script setup>
import { ref } from "vue";
import { Switch, SwitchGroup, SwitchLabel } from "@headlessui/vue";
import { useUserStore } from "~/composables/useUserStore";

// Retrieve user data from the composable store.
const userStore = useUserStore();
const height = ref(userStore.value.height || "");
const birthday = ref(userStore.value.birthday || "");
// Use a boolean for the toggle: true for metric, false for imperial (default)
const isMetric = ref(userStore.value.unitPreference === "metric");

// State to indicate form submission.
const isSubmitting = ref(false);

function saveMetrics() {
  isSubmitting.value = true;
  // Simulate async submission (replace with your API call if needed)
  setTimeout(() => {
    userStore.value = {
      ...userStore.value,
      height: height.value,
      unitPreference: isMetric.value ? "metric" : "imperial",
      birthday: birthday.value,
    };
    isSubmitting.value = false;
  }, 1000);
}

function cancelUpdate() {
  height.value = userStore.value.height || "";
  birthday.value = userStore.value.birthday || "";
  isMetric.value = userStore.value.unitPreference === "metric";
}
</script>
```

### Explanation

- **Headless UI Switch Toggle:**  
  The unit preference field now uses a Switch from headlessui. When toggled on, it sets `isMetric` to true (indicating "metric"); when off, it indicates "imperial."

- **Loading Indicator:**  
  The `isSubmitting` state disables inputs and buttons during submission. The Save button shows a spinning SVG and "Saving..." text when in the submitting state.

- **State Management:**  
  The component uses your `useUserStore` composable to retrieve and update user data.

Feel free to adjust the styling and timing as needed for your project.


We want to input the height in feet and inches so let's clean that up. But keep in mind we store the data in metric but display it in imperial. So weight should display as lbs but store as kg. And we need those usints labels on the interface. 


Below is the updated component. It now splits height into feet and inches and adds a weight input (displayed in lbs) while converting both to metric for storage. It also displays unit labels and shows a loading state when saving.

```vue
<template>
  <form class="space-y-12" @submit.prevent="saveMetrics">
    <div class="grid grid-cols-1 gap-x-8 gap-y-10 border-b border-gray-900/10 pb-12 md:grid-cols-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900">User Metrics</h2>
        <p class="mt-1 text-sm text-gray-600">
          Update your height, weight, and birthday.
        </p>
      </div>
      <div class="grid max-w-2xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
        <!-- Height Field (Feet & Inches) -->
        <div class="sm:col-span-3">
          <label class="block text-sm font-medium text-gray-900">Height</label>
          <div class="mt-2 flex space-x-4">
            <div class="flex-1">
              <input
                type="number"
                v-model.number="heightFeet"
                :disabled="isSubmitting"
                class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
                placeholder="ft"
              />
              <p class="mt-1 text-xs text-gray-500">ft</p>
            </div>
            <div class="flex-1">
              <input
                type="number"
                v-model.number="heightInches"
                :disabled="isSubmitting"
                class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
                placeholder="in"
              />
              <p class="mt-1 text-xs text-gray-500">in</p>
            </div>
          </div>
        </div>

        <!-- Weight Field (in lbs) -->
        <div class="sm:col-span-3">
          <label for="weight" class="block text-sm font-medium text-gray-900">Weight</label>
          <div class="mt-2">
            <div class="relative">
              <input
                type="number"
                id="weight"
                v-model.number="weightLbs"
                :disabled="isSubmitting"
                class="block w-full rounded-md bg-white px-3 py-1.5 pr-16 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
                placeholder="Enter your weight in lbs"
              />
              <span class="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500">
                lbs
              </span>
            </div>
          </div>
        </div>

        <!-- Birthday Field -->
        <div class="sm:col-span-3">
          <label for="birthday" class="block text-sm font-medium text-gray-900">Birthday</label>
          <div class="mt-2">
            <input
              type="date"
              name="birthday"
              id="birthday"
              v-model="birthday"
              :disabled="isSubmitting"
              class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline outline-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:outline-indigo-600 sm:text-sm"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <button
        type="button"
        class="text-sm font-semibold text-gray-900"
        @click="cancelUpdate"
        :disabled="isSubmitting"
      >
        Cancel
      </button>
      <button
        type="submit"
        :disabled="isSubmitting"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
      >
        <template v-if="isSubmitting">
          <svg
            class="animate-spin inline h-5 w-5 mr-2 text-white"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8z"
            ></path>
          </svg>
          Saving...
        </template>
        <template v-else>
          Save
        </template>
      </button>
    </div>
  </form>
</template>

<script setup>
import { ref } from "vue";
import { Switch, SwitchGroup, SwitchLabel } from "@headlessui/vue";
import { useUserStore } from "~/composables/useUserStore";

// Conversion functions
function cmToFeetInches(cm) {
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return { feet, inches };
}

function feetInchesToCm(feet, inches) {
  return (feet * 30.48) + (inches * 2.54);
}

function kgToLbs(kg) {
  return Math.round(kg / 0.453592);
}

function lbsToKg(lbs) {
  return lbs * 0.453592;
}

// Retrieve user data from the composable store.
const userStore = useUserStore();

// For unit toggle (if needed elsewhere, default remains imperial)
const isMetric = ref(userStore.value.unitPreference === "metric");

// Reactive references for height in imperial units and weight in lbs.
const heightFeet = ref(0);
const heightInches = ref(0);
const weightLbs = ref(0);
const birthday = ref(userStore.value.birthday || "");

// Initialize values from store (assumes stored height in cm and weight in kg)
if (userStore.value.height) {
  const { feet, inches } = cmToFeetInches(userStore.value.height);
  heightFeet.value = feet;
  heightInches.value = inches;
}
if (userStore.value.weight) {
  weightLbs.value = kgToLbs(userStore.value.weight);
}

// State to indicate form submission.
const isSubmitting = ref(false);

function saveMetrics() {
  isSubmitting.value = true;
  // Convert inputs from imperial to metric
  const newHeight = feetInchesToCm(heightFeet.value, heightInches.value);
  const newWeight = lbsToKg(weightLbs.value);
  setTimeout(() => {
    userStore.value = {
      ...userStore.value,
      height: newHeight, // stored in cm
      weight: newWeight, // stored in kg
      unitPreference: isMetric.value ? "metric" : "imperial",
      birthday: birthday.value,
    };
    isSubmitting.value = false;
  }, 1000);
}

function cancelUpdate() {
  if (userStore.value.height) {
    const { feet, inches } = cmToFeetInches(userStore.value.height);
    heightFeet.value = feet;
    heightInches.value = inches;
  } else {
    heightFeet.value = 0;
    heightInches.value = 0;
  }
  if (userStore.value.weight) {
    weightLbs.value = kgToLbs(userStore.value.weight);
  } else {
    weightLbs.value = 0;
  }
  birthday.value = userStore.value.birthday || "";
  isMetric.value = userStore.value.unitPreference === "metric";
}
</script>
```

### Explanation

- **Height Inputs:**  
  The height field is split into two numeric inputs for feet and inches. Each input is labeled with a small "ft" or "in" helper text.

- **Weight Input:**  
  A new weight field is added. It displays an input for weight with a right-aligned "lbs" label.  
- **Conversion:**  
  When saving, the component converts feet/inches to centimeters (height) and lbs to kilograms (weight) using standard conversion factors.
- **Loading State:**  
  The Save button shows a spinner and "Saving..." text while submitting, and all inputs are disabled during submission.

This modern, clean design leverages Tailwind CSS and Headless UI components to ensure clarity and usability.


Lets infer the users age and display that in the form as well. And make sure we update the store on save.


**Topic:** [[chatgpt-clusters/coding_devops]]
