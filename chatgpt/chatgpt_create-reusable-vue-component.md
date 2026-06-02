---
title: "Create Reusable Vue Component"
type: guide
created: 2023-05-07
updated: 2023-05-07
source: chatgpt-export
conversation_id: 9ff21d5b-feed-4625-8a85-0ed3d2b71436
message_count: 4
tags: [chatgpt, import, code]
---
# Create Reusable Vue Component

> Conversation ID: 9ff21d5b-feed-4625-8a85-0ed3d2b71436
> Created: 2023-05-07T03:54:28Z
> Updated: 2023-05-07T03:55:31Z
> Messages: 4

---

## User

<template>
  <div class="bg-white shadow sm:rounded-lg">
    <div class="px-4 py-5 sm:p-6">
      <div class="sm:flex sm:items-start sm:justify-between">
        <div>
          <h3 class="text-base font-semibold leading-6 text-gray-900">
            Manage subscription
          </h3>
          <div class="mt-2 max-w-xl text-sm text-gray-500">
            <p>
              Lorem ipsum dolor sit amet consectetur adipisicing elit.
              Recusandae voluptatibus corrupti atque repudiandae nam.
            </p>
          </div>
        </div>
        <div
          class="mt-5 sm:ml-6 sm:mt-0 sm:flex sm:flex-shrink-0 sm:items-center">
          <button
            type="button"
            class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            Change plan
          </button>
        </div>
      </div>
    </div>
  </div>
</template>


lets make this a component with all the props we need to resuse it

---

## Assistant

Certainly! Here's an example of the given code transformed into a reusable component in Vue.js, with props added for customization:

```vue
<template>
  <div :class="containerClasses">
    <div :class="contentClasses">
      <div :class="headerClasses">
        <h3 :class="titleClasses">{{ title }}</h3>
        <div :class="descriptionClasses">
          <p>{{ description }}</p>
        </div>
      </div>
      <div :class="buttonContainerClasses">
        <button
          type="button"
          :class="buttonClasses"
          @click="onChangePlan"
        >
          {{ buttonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    buttonText: {
      type: String,
      required: true,
    },
  },
  computed: {
    containerClasses() {
      return 'bg-white shadow sm:rounded-lg';
    },
    contentClasses() {
      return 'px-4 py-5 sm:p-6';
    },
    headerClasses() {
      return 'sm:flex sm:items-start sm:justify-between';
    },
    titleClasses() {
      return 'text-base font-semibold leading-6 text-gray-900';
    },
    descriptionClasses() {
      return 'mt-2 max-w-xl text-sm text-gray-500';
    },
    buttonContainerClasses() {
      return 'mt-5 sm:ml-6 sm:mt-0 sm:flex sm:flex-shrink-0 sm:items-center';
    },
    buttonClasses() {
      return 'inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';
    },
  },
  methods: {
    onChangePlan() {
      // Handle the change plan action
      // You can emit an event or perform any necessary logic here
    },
  },
};
</script>
```

Now, you can reuse this component by passing the necessary props:

```vue
<template>
  <div>
    <!-- Example usage of the component -->
    <ManageSubscription
      title="Manage subscription"
      description="Lorem ipsum dolor sit amet consectetur adipisicing elit. Recusandae voluptatibus corrupti atque repudiandae nam."
      buttonText="Change plan"
    />
  </div>
</template>

<script>
import ManageSubscription from './ManageSubscription.vue';

export default {
  components: {
    ManageSubscription,
  },
};
</script>
```

By using the `ManageSubscription` component and passing the appropriate props, you can customize the title, description, and button text as needed.

---

## User

ok but lets call it ActionPanel and make all the terms generic so it can be used for other use cases

---

## Assistant

Certainly! Here's an updated version of the component renamed to `ActionPanel` with generic terms:

```vue
<template>
  <div :class="containerClasses">
    <div :class="contentClasses">
      <div :class="headerClasses">
        <h3 :class="titleClasses">{{ title }}</h3>
        <div :class="descriptionClasses">
          <p>{{ description }}</p>
        </div>
      </div>
      <div :class="buttonContainerClasses">
        <button
          type="button"
          :class="buttonClasses"
          @click="onActionClick"
        >
          {{ buttonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    buttonText: {
      type: String,
      required: true,
    },
  },
  computed: {
    containerClasses() {
      return 'bg-white shadow sm:rounded-lg';
    },
    contentClasses() {
      return 'px-4 py-5 sm:p-6';
    },
    headerClasses() {
      return 'sm:flex sm:items-start sm:justify-between';
    },
    titleClasses() {
      return 'text-base font-semibold leading-6 text-gray-900';
    },
    descriptionClasses() {
      return 'mt-2 max-w-xl text-sm text-gray-500';
    },
    buttonContainerClasses() {
      return 'mt-5 sm:ml-6 sm:mt-0 sm:flex sm:flex-shrink-0 sm:items-center';
    },
    buttonClasses() {
      return 'inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';
    },
  },
  methods: {
    onActionClick() {
      // Handle the action click event
      // You can emit an event or perform any necessary logic here
    },
  },
};
</script>
```

You can now use the `ActionPanel` component with generic terms for various use cases:

```vue
<template>
  <div>
    <!-- Example usage of the component -->
    <ActionPanel
      title="Manage Action"
      description="Lorem ipsum dolor sit amet consectetur adipisicing elit. Recusandae voluptatibus corrupti atque repudiandae nam."
      buttonText="Perform Action"
    />
  </div>
</template>

<script>
import ActionPanel from './ActionPanel.vue';

export default {
  components: {
    ActionPanel,
  },
};
</script>
```

By passing different props to the `ActionPanel` component, you can customize the title, description, and button text for different action panels in your application.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
