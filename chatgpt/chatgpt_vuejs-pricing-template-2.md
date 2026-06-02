---
conversation_id: 9f678771-a959-4403-a235-846b61b840eb
created: 2023-03-03
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Vue.js Pricing Template
type: guide
updated: 2023-03-03
---

# Vue.js Pricing Template

**Related:** [[business_startup]]

> Conversation ID: 9f678771-a959-4403-a235-846b61b840eb
> Created: 2023-03-03T05:38:30Z
> Updated: 2023-03-03T05:38:30Z
> Messages: 4

---

## User

<template>
  <div class="">
    <!-- Pricing with four tiers and toggle -->
    <div class="bg-gradient-to-b from-slate-50 to-white">
      <div class="mx-auto max-w-7xl px-4 pt-24 sm:px-6 lg:px-8">
        <div class="mx-auto max-w-4xl text-center">
          <h2 class="text-base font-semibold leading-7 text-indigo-600">
            Pricing
          </h2>
          <p
            class="mt-2 text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Pricing plans for teams of&nbsp;all&nbsp;sizes
          </p>
        </div>
        <p
          class="mx-auto mt-6 max-w-2xl text-center text-lg leading-8 text-gray-600">
          Choose an affordable plan that’s packed with incredible features like
          Jovie AI.
        </p>

        <div class="mt-16 flex justify-center">
          <RadioGroup
            v-model="annualBilling"
            class="grid grid-cols-2 gap-x-1 rounded-full p-1 text-center text-xs font-semibold leading-5 ring-1 ring-inset ring-gray-200 transition-all">
            <RadioGroupLabel class="sr-only">Payment frequency</RadioGroupLabel>
            <RadioGroupOption
              as="template"
              v-for="option in frequencies"
              :key="option.value"
              :value="option"
              v-slot="{ checked }">
              <div
                :class="[
                  checked ? 'bg-indigo-600 text-white' : 'text-gray-500',
                  'cursor-pointer rounded-full py-1 px-2.5',
                ]">
                <span>{{ option.label }}</span>
              </div>
            </RadioGroupOption>
          </RadioGroup>
        </div>
        <div class="sm:align-center sm:flex sm:flex-col">
          <!-- <div
            class="relative mt-6 flex self-center rounded-lg bg-slate-200 py-0.5 px-2 sm:mt-8">
            <SwitchGroup as="div" class="flex items-center">
              <div class="flex items-center">
                <Switch
                  v-model="annualBilling"
                  :class="annualBilling ? 'bg-slate-200' : 'bg-slate-200'"
                  class="relative inline-flex h-14 w-96 items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
                  <span
                    :class="annualBilling ? 'translate-x-0' : 'translate-x-48'"
                    class="inline-block h-12 w-1/2 transform rounded-md bg-white shadow-sm transition-transform" />
                  <div class="absolute mx-auto grid w-full grid-cols-2">
                    <div
                      :class="
                        annualBilling ? 'text-slate-700' : 'text-slate-500'
                      "
                      class="text-sm font-medium focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-indigo-500 sm:w-auto sm:px-8">
                      Yearly Billing
                    </div>
                    <div
                      :class="
                        annualBilling ? 'text-slate-500' : 'text-slate-700'
                      "
                      class="text-sm font-medium text-slate-700 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-indigo-500 sm:w-auto sm:px-8">
                      Monthly Billing
                    </div>
                  </div>
                </Switch>
              </div>
            </SwitchGroup>
          </div> -->
        </div>
        <div
          class="mx-auto mt-12 space-y-4 sm:mt-16 sm:grid sm:grid-cols-2 sm:gap-6 sm:space-y-0 lg:mx-auto lg:max-w-4xl xl:mx-auto xl:max-w-5xl xl:grid-cols-3">
          <div
            v-for="tier in tiers"
            :key="tier.name"
            class="divide-y divide-slate-200 rounded-lg shadow-sm"
            :class="[
              { 'border-2 border-indigo-400': tier.featured == true },
              'border border-slate-200',
            ]">
            <div class="p-6">
              <div class="flex items-center justify-between gap-x-4">
                <h3
                  :id="tier.id"
                  :class="[
                    { 'text-sky-600': tier.color == 'sky' },
                    { 'text-indigo-600': tier.color == 'indigo' },
                    { 'text-pink-600': tier.color == 'pink' },
                    { 'text-violet-600': tier.color == 'violet' },
                    { 'text-red-600': tier.color == 'red' },
                    'text-lg font-medium leading-6 text-slate-900',
                  ]"
                  class="text-lg font-medium leading-6">
                  {{ tier.name }}
                </h3>
                <p
                  v-if="tier.mostPopular"
                  class="rounded-full bg-indigo-600/10 py-1 px-2.5 text-xs font-semibold leading-5 text-indigo-600">
                  Most popular
                </p>
              </div>
              <p class="mt-4 text-sm text-slate-500">
                {{ tier.description }}
              </p>
              <p v-if="tier.name === 'Enterprise'" class="mt-4">
                <span class="text-xs font-medium text-slate-500">Starts at</span
                ><br />
                <span class="-mt-2 text-4xl font-extrabold text-slate-900"
                  >${{ (tier.priceAnnual / 12).toFixed(0) }}</span
                >
                {{ ' ' }}
                <span class="text-base font-medium text-slate-500">/mo</span>
                <br />
                <span class="text-sm font-medium text-slate-500"
                  >Annual billing only</span
                >
              </p>
              <p v-else-if="annualBilling" class="mt-4">
                <span class="text-xs font-medium text-slate-500"></span><br />
                <span class="text-4xl font-extrabold text-slate-900"
                  >${{ (tier.priceAnnual / 12).toFixed(0) }}</span
                >
                {{ ' ' }}
                <span class="text-base font-medium text-slate-500">/mo</span
                ><span
                  v-if="tier.name == 'Team'"
                  class="ml-0.5 text-sm font-medium text-slate-400"
                  >/seat</span
                >
                <br />
                <span class="text-sm font-medium text-slate-500"
                  >Billed as
                  <span class="text-sm font-medium text-slate-400 line-through">
                    ${{ tier.priceMonthly.toFixed(0) * 12 }}</span
                  >
                  ${{ tier.priceAnnual.toFixed(0) }}/yr
                </span>
              </p>
              <p v-else class="mt-4">
                <span class="text-xs font-medium text-slate-500"></span><br />
                <span class="text-4xl font-extrabold text-slate-900"
                  >${{ tier.priceMonthly }}</span
                >
                {{ ' ' }}
                <span class="text-base font-medium text-slate-500">/mo</span
                ><span
                  v-if="tier.name == 'Team'"
                  class="ml-0.5 text-sm font-medium text-slate-400"
                  >/seat</span
                >
                <br />
                <span class="text-sm font-medium text-slate-500"
                  >Billed monthly</span
                >
              </p>
              <router-link
                v-if="tier.name == 'Enterprise'"
                :to="tier.href"
                class="mt-8 block w-full rounded-md border border-indigo-600 bg-white py-2 text-center text-sm font-semibold text-indigo-600 hover:bg-indigo-600 hover:text-white"
                >Contact Sales</router-link
              >
              <router-link
                v-else-if="tier.featured"
                :to="tier.href"
                class="mt-8 block w-full rounded-md border border-transparent bg-indigo-600 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-700"
                >Get started</router-link
              ><router-link
                v-else
                :to="tier.href"
                class="mt-8 block w-full rounded-md border border-indigo-600 bg-white py-2 text-center text-sm font-semibold text-indigo-600 hover:bg-indigo-600 hover:text-white"
                >Get started</router-link
              >
            </div>
            <div class="px-6 pt-6 pb-8">
              <h3
                class="text-xs font-medium uppercase tracking-wide text-slate-900">
                What's included
              </h3>
              <ul role="list" class="mt-6 space-y-4">
                <li
                  v-for="feature in tier.features"
                  :key="feature"
                  class="flex space-x-3">
                  <component
                    :is="feature.icon"
                    class="h-5 w-5 flex-shrink-0 text-slate-400"
                    aria-hidden="true" />
                  <span class="text-sm text-slate-500">{{ feature.name }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!--Free Account-->
    <div
      class="relative mx-auto mt-8 max-w-5xl bg-white px-4 sm:px-6 lg:mt-5 lg:px-8">
      <div class="mx-auto max-w-md lg:max-w-5xl">
        <div
          class="rounded-lg bg-slate-50 px-6 py-8 sm:p-10 lg:flex lg:items-center">
          <div class="flex-1">
            <div>
              <h3
                class="inline-flex rounded-md bg-slate-100 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Get started with a free account
              </h3>
            </div>
            <div class="mt-4 text-xs text-slate-600">
              Not ready to commit? Our basic plan is completely free.
              <span class="font-semibold text-slate-900"
                >No credit card required</span
              >.
            </div>
          </div>
          <div class="mt-6 rounded-md shadow lg:mt-0 lg:ml-10 lg:flex-shrink-0">
            <router-link
              to="signup"
              class="flex items-center justify-center rounded-md border border-transparent bg-white px-5 py-3 text-base font-medium text-slate-900 hover:bg-slate-50">
              Try Jovie free
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- FAQ -->
  <div class="mt-4 bg-gradient-to-b from-white to-slate-50">
    <div class="mx-auto max-w-7xl py-12 px-4 sm:py-16 sm:px-6 lg:py-24 lg:px-8">
      <div class="mx-auto max-w-3xl divide-y-2 divide-slate-200">
        <h2
          class="text-center text-3xl font-extrabold text-slate-900 sm:text-4xl">
          Frequently asked questions
        </h2>
        <dl class="mt-6 space-y-6 divide-y divide-slate-200">
          <Disclosure
            as="div"
            v-for="faq in faqs"
            :key="faq.question"
            class="pt-6"
            v-slot="{ open }">
            <dt class="text-lg">
              <DisclosureButton
                class="flex w-full items-start justify-between text-left text-slate-400">
                <span class="font-medium text-slate-900">
                  {{ faq.question }}
                </span>
                <span class="ml-6 flex h-7 items-center">
                  <ChevronDownIcon
                    :class="[
                      open ? '-rotate-180' : 'rotate-0',
                      'h-6 w-6 transform',
                    ]"
                    aria-hidden="true" />
                </span>
              </DisclosureButton>
            </dt>
            <DisclosurePanel as="dd" class="mt-2 pr-12">
              <p class="text-base text-slate-500">
                {{ faq.answer }}
              </p>
            </DisclosurePanel>
          </Disclosure>
        </dl>
      </div>
    </div>
  </div>
  <!-- CTA -->
  <HomeCTA4 />
</template>

---

## Assistant

This code is a Vue.js template for displaying pricing plans. It includes a RadioGroup component for toggling between annual and monthly billing frequencies, and a set of tiers for different pricing plans.

The RadioGroup component is used to allow users to switch between annual and monthly billing frequencies. The component is given a v-model attribute of "annualBilling" which is used to track the currently selected frequency. The component is also given a class attribute to define its appearance and styling.

The tiers for the different pricing plans are displayed using a v-for directive. Each tier has a name, description, and color. The tiers are contained in a div element with a class attribute that sets the styling for the tier cards. The div element is also given a v-for directive to iterate over each tier.

Each tier card displays the name of the tier, a badge indicating whether it is the most popular, and a description of the plan. The most popular badge is only displayed for the most popular plan. The name and description of each plan are displayed using Vue.js directives.

Overall, this code provides a clean and user-friendly interface for displaying pricing plans with the ability to toggle between annual and monthly billing frequencies.

---

## User

replace annualBilling with frequencies.  this will be the code in the script tag for it:
const frequencies = [
  { value: 'monthly', label: 'Monthly', priceSuffix: '/month' },
  { value: 'annually', label: 'Annually', priceSuffix: '/year' },
];

const frequency = ref(frequencies[0]);

---

## Assistant

Here's the updated code with the `frequencies` array and `frequency` variable declared using Vue 3's composition API:

```
<template>
  <div>
    <select v-model="frequency">
      <option v-for="freq in frequencies" :value="freq">{{freq.label}}</option>
    </select>
    <p>{{ frequency.value }}{{ priceSuffix }}</p>
  </div>
</template>

<script>
import { ref } from 'vue';

const frequencies = [
  { value: 'monthly', label: 'Monthly', priceSuffix: '/month' },
  { value: 'annually', label: 'Annually', priceSuffix: '/year' },
];

export default {
  setup() {
    const frequency = ref(frequencies[0]);
    const priceSuffix = ref(frequency.value.priceSuffix);

    return {
      frequency,
      priceSuffix,
      frequencies,
    };
  },
};
</script>
```

In this updated code, `frequencies` is an array of objects that contains the different frequency options with their respective labels and price suffixes. `frequency` is a reactive variable that is initialized with the first frequency option in the `frequencies` array.

In the template, a `select` element is used to display the available frequency options. The selected option is bound to the `frequency` variable using `v-model`. The selected frequency's price suffix is displayed in a `p` element below the `select` element.

Using the composition API, `priceSuffix` is also declared as a reactive variable that is updated whenever `frequency` changes its value.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-pricing-template]]
- [[chatgpt/chatgpt_vuejs-button-template-2]]
- [[chatgpt/chatgpt_vuejs-button-template]]
- [[chatgpt/chatgpt_vuejs-component-template]]
- [[chatgpt/chatgpt_vuejs-form-input-template]]
