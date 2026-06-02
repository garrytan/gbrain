---
title: "Add Icons to Stats"
type: guide
created: 2023-11-24
updated: 2023-11-24
source: chatgpt-export
conversation_id: e6d695e7-e36d-479d-8581-002bde0abcb4
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Add Icons to Stats

> Conversation ID: e6d695e7-e36d-479d-8581-002bde0abcb4
> Created: 2023-11-24T10:57:44Z
> Updated: 2023-11-24T11:08:39Z
> Messages: 6

---

## User

<template>
    <div v-if="stats.length > 0">
        Body Composition Profile
      <dl class="mt-5 grid grid-cols-1 divide-y divide-gray-200 overflow-hidden rounded-lg bg-white shadow md:grid-cols-3 md:divide-x md:divide-y-0">
        <div v-for="item in stats" :key="item.name" class="px-4 py-5 sm:p-6">
          <dt class="text-base font-normal text-gray-900">{{ item.name }}</dt>
          <dd class="mt-1 flex items-baseline justify-between md:block lg:flex">
            <div class="flex items-baseline text-2xl font-semibold text-indigo-600">
              {{ item.stat }}
             <!--  <span class="ml-2 text-sm font-medium text-gray-500">from {{ item.previousStat }}</span> -->
            </div>
  
            <!-- <div :class="[item.changeType === 'increase' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800', 'inline-flex items-baseline rounded-full px-2.5 py-0.5 text-sm font-medium md:mt-2 lg:mt-0']">
              <ArrowUpIcon v-if="item.changeType === 'increase'" class="-ml-1 mr-0.5 h-5 w-5 flex-shrink-0 self-center text-green-500" aria-hidden="true" />
              <ArrowDownIcon v-else class="-ml-1 mr-0.5 h-5 w-5 flex-shrink-0 self-center text-red-500" aria-hidden="true" />
              <span class="sr-only"> {{ item.changeType === 'increase' ? 'Increased' : 'Decreased' }} by </span>
              {{ item.change }}
            </div> -->
          </dd>
        </div>
      </dl>
    </div>
    <div class="font-bold mx-auto px-8 max-w-3xl" v-else>
No data to display. Stats will appear here once you've added an entry.
    </div>
  </template>
  
<script setup>
import { computed } from 'vue';
import { usePage } from '@inertiajs/vue3';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/vue/20/solid'

// Getting the weight logs data from the page props
const weightLogs = usePage().props.weightLogs || [];
const user = usePage().props.auth.user
const ffmi = usePage().props.ffmi
const leanbodymass = usePage().props.leanBodyMass

// Compute statistics
const totalEntries = computed(() => weightLogs?.length || 0);


const avgWeight = computed(() => {
    const totalWeight = weightLogs.reduce((sum, log) => sum + log.weight, 0);
    return (totalWeight / totalEntries.value).toFixed(2);
});

const latestBodyFat = computed(() => {
    return weightLogs.length > 0 ? weightLogs[0].body_fat_percentage + '%' : 'N/A';
});

// Function to convert height from centimeters to feet and inches
function convertHeight(cm) {
    const inches = cm / 2.54;
    const feet = Math.floor(inches / 12);
    const remainingInches = Math.round(inches % 12);
    return `${feet}' ${remainingInches}"`;
}
// You can also calculate changes from previous period if needed

// Define stats for the template
const stats = computed(() => [
{ name: 'Age', stat: user.age },
{ name: 'Height', stat: convertHeight(user.height) },
   
    //round the ffmi to 2 decimal places
    { name: 'FFMI' , stat: ffmi.toFixed(2)},
    { name: 'Lean Body Mass', stat: `${leanbodymass.toFixed(2)} lbs` },
    { name: 'Avg. Weight', stat: `${avgWeight.value} lbs` }, // assuming weight is in pounds
    { name: 'Latest BF%', stat: latestBodyFat.value },
    { name: 'Total Entries', stat: totalEntries.value },
    //add user age
  
    //add height
   
   

    // Add more stats as needed
]);
</script>


lets add icons using the vue heroicon library to each of the stats

---

## Assistant

To add icons to each of the stats using the Vue Heroicons library, you can follow these steps. The example provided assumes you are familiar with Vue.js and the use of components. 

First, ensure you have imported the specific icons you need from `@heroicons/vue/20/solid`. For instance:

```javascript
import { UserIcon, ScaleIcon, HeartIcon, ChartBarIcon, CalendarIcon, RulerIcon, ArrowRightIcon } from '@heroicons/vue/20/solid';
```

Then, modify the `stats` array in your script to include an icon for each stat. Here's how you can do it:

```javascript
const stats = computed(() => [
    { name: 'Age', stat: user.age, icon: UserIcon },
    { name: 'Height', stat: convertHeight(user.height), icon: RulerIcon },
    { name: 'FFMI', stat: ffmi.toFixed(2), icon: ChartBarIcon },
    { name: 'Lean Body Mass', stat: `${leanbodymass.toFixed(2)} lbs`, icon: ScaleIcon },
    { name: 'Avg. Weight', stat: `${avgWeight.value} lbs`, icon: ScaleIcon },
    { name: 'Latest BF%', stat: latestBodyFat.value, icon: HeartIcon },
    { name: 'Total Entries', stat: totalEntries.value, icon: CalendarIcon },
]);
```

Finally, update the template to render these icons. Modify the `<div v-for="item in stats">` block as follows:

```html
<div v-for="item in stats" :key="item.name" class="px-4 py-5 sm:p-6">
    <dt class="text-base font-normal text-gray-900">
        <item.icon class="h-5 w-5 text-gray-400 inline-block mr-2" aria-hidden="true" />
        {{ item.name }}
    </dt>
    <dd class="mt-1 flex items-baseline justify-between md:block lg:flex">
        <div class="flex items-baseline text-2xl font-semibold text-indigo-600">
            {{ item.stat }}
        </div>
    </dd>
</div>
```

This will render each stat with its corresponding icon. Make sure to adjust the class names and structure according to your design requirements.

---

## User

UserStats.vue:25 [Vue warn]: Failed to resolve component: item.icon
If this is a native custom element, make sure to exclude it from component resolution via compilerOptions.isCustomElement. 
  at <UserStats user= 

---

## Assistant

The error you're encountering, "Failed to resolve component: item.icon", suggests that Vue is trying to interpret `item.icon` as a component name, but it's actually a variable holding a component. In Vue 3, you can dynamically render components using the `resolveDynamicComponent` function or the `component` tag.

Here's how you can adjust your code to fix this issue:

First, ensure that `resolveDynamicComponent` is imported in your script setup:

```javascript
import { resolveDynamicComponent } from 'vue';
```

Then, in your template, replace `<item.icon>` with a dynamic component tag. You can do this using the `<component :is="...">` syntax:

```html
<div v-for="item in stats" :key="item.name" class="px-4 py-5 sm:p-6">
    <dt class="text-base font-normal text-gray-900">
        <component :is="item.icon" class="h-5 w-5 text-gray-400 inline-block mr-2" aria-hidden="true" />
        {{ item.name }}
    </dt>
    <dd class="mt-1 flex items-baseline justify-between md:block lg:flex">
        <div class="flex items-baseline text-2xl font-semibold text-indigo-600">
            {{ item.stat }}
        </div>
    </dd>
</div>
```

In this revised approach, the `:is` directive dynamically binds the component to be rendered based on the value of `item.icon`. This tells Vue to resolve the component dynamically at runtime, which should resolve the error you're encountering.

---

## User

great but lets convert it to use this style instead
<div class="bg-gray-900">
    <div class="mx-auto max-w-7xl">
      <div class="grid grid-cols-1 gap-px bg-white/5 sm:grid-cols-2 lg:grid-cols-4">
        <div v-for="stat in stats" :key="stat.name" class="bg-gray-900 px-4 py-6 sm:px-6 lg:px-8">
          <p class="text-sm font-medium leading-6 text-gray-400">{{ stat.name }}</p>
          <p class="mt-2 flex items-baseline gap-x-2">
            <span class="text-4xl font-semibold tracking-tight text-white">{{ stat.value }}</span>
            <span v-if="stat.unit" class="text-sm text-gray-400">{{ stat.unit }}</span>
          </p>
        </div>
      </div>
    </div>
  </div>

---

## Assistant

To convert your template to use the new style you've described, you'll need to update both your Vue template and the `stats` computed property. The new style involves a darker theme with a grid layout. Here's how you can do it:

### 1. Update the Computed `stats` Property

First, adjust your `stats` computed property in the script to include units (if any) for each statistic. For example:

```javascript
const stats = computed(() => [
    { name: 'Age', value: user.age },
    { name: 'Height', value: convertHeight(user.height) },
    { name: 'FFMI', value: ffmi.toFixed(2) },
    { name: 'Lean Body Mass', value: leanbodymass.toFixed(2), unit: 'lbs' },
    { name: 'Avg. Weight', value: avgWeight.value, unit: 'lbs' },
    { name: 'Latest BF%', value: latestBodyFat.value },
    { name: 'Total Entries', value: totalEntries.value },
]);
```

### 2. Update the Vue Template

Then, modify your Vue template to match the new style:

```html
<div class="bg-gray-900">
    <div class="mx-auto max-w-7xl">
        <div class="grid grid-cols-1 gap-px bg-white/5 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="stat in stats" :key="stat.name" class="bg-gray-900 px-4 py-6 sm:px-6 lg:px-8">
                <p class="text-sm font-medium leading-6 text-gray-400">{{ stat.name }}</p>
                <p class="mt-2 flex items-baseline gap-x-2">
                    <span class="text-4xl font-semibold tracking-tight text-white">{{ stat.value }}</span>
                    <span v-if="stat.unit" class="text-sm text-gray-400">{{ stat.unit }}</span>
                </p>
            </div>
        </div>
    </div>
</div>
```

This code will render each stat in a grid layout, with each stat's name, value, and unit (if any) displayed in the specified style. The `v-if` directive on the unit ensures that it only displays if a unit is provided for the stat. The overall appearance will be a series of dark-themed cards in a grid, each showing a different statistic.
