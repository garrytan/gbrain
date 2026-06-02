---
title: "Configure Storybook For Vue3 
"
type: guide
created: 2023-01-22
updated: 2023-01-22
source: chatgpt-export
conversation_id: dd0d796d-518f-44d7-8f2f-bb4ea942feb0
message_count: 6
tags: [chatgpt, import, code]
---
# Configure Storybook For Vue3 


> Conversation ID: dd0d796d-518f-44d7-8f2f-bb4ea942feb0
> Created: 2023-01-22T20:14:54Z
> Updated: 2023-01-22T20:14:54Z
> Messages: 6

---

## User

im using storybook in a vue 3 project. currently it only shows stories from src folder but i want to keep my components and stories files together in my existing component directory which is resources/js/components

---

## Assistant

To configure Storybook to show stories from a different directory in a Vue 3 project, you'll need to update the `config.js` file in your `.storybook` directory. Specifically, you'll need to update the `stories` property in the `configure` method to point to your desired directory.

For example, if your component and stories files are located in `resources/js/components`, you would update the `stories` property to be `resources/js/components/**/*.stories.js`.

Here's an example of what your config.js might look like:
```
import { configure } from '@storybook/vue';
import Vue from 'vue';

// automatically import all files ending in *.stories.js
const req = require.context('../resources/js/components', true, /\.stories\.js$/);
function loadStories() {
  req.keys().forEach(filename => req(filename));
}

configure(loadStories, module);
```
After this, you should be able to run storybook and it should show stories from `resources/js/components` directory.


---

## User

write a stories.js file for this component:
<template>
  <input
    type="checkbox"
    v-bind:checked="checked"
    v-on:input="$emit('input', $event.target.checked)"
    class="h-3 w-3 rounded border-slate-300 text-indigo-600 focus-visible:ring-indigo-500 dark:border-jovieDark-border dark:text-indigo-400 sm:left-6" />
</template>

<script>
export default {
  props: {
    checked: {
      type: Boolean,

      required: true,
    },
  },
};
</script>


---

## Assistant

Here is an example of a `stories.js` file for the component you provided:
```
import { storiesOf } from '@storybook/vue';
import Checkbox from './Checkbox.vue';

storiesOf('Checkbox', module)
  .add('default', () => ({
    components: { Checkbox },
    template: '<checkbox :checked="false"/>'
  }))
  .add('checked', () => ({
    components: { Checkbox },
    template: '<checkbox :checked="true"/>'
  }))
```

Here, I've imported the `Checkbox` component and used the `storiesOf` method to create two stories for it. The first story, labeled "default," uses the `template` option to render the component with the `checked` prop set to `false`. The second story, labeled "checked," uses the `template` option to render the component with the `checked` prop set to `true`.

You can also add more stories to test different states of the component like : `disabled`, `hover` and so on.
```
  .add('disabled', () => ({
    components: { Checkbox },
    template: '<checkbox :checked="false" :disabled="true"/>'
  }))
  .add('hover', () => ({
    components: { Checkbox },
    template: '<checkbox :checked="false" :hover="true"/>'
  }))
```

It is important to keep in mind that this is just one example, and you can always customize the stories to fit your specific needs.


---

## User

create args

---

## Assistant

Here is an example of how you can create `args` for your `Checkbox` component in the `stories.js` file:

```
import { storiesOf } from '@storybook/vue';
import Checkbox from './Checkbox.vue';

const checkboxArgs = {
    checked: {
        type: Boolean,
        default: false
    },
    disabled: {
        type: Boolean,
        default: false
    },
    hover: {
        type: Boolean,
        default: false
    }
}

storiesOf('Checkbox', module)
  .add('default', () => ({
    components: { Checkbox },
    template: '<checkbox v-bind="$props"/>',
    props: checkboxArgs
  }))
  .add('checked', () => ({
    components: { Checkbox },
    template: '<checkbox v-bind="$props" :checked="true"/>',
    props: checkboxArgs
  }))
  .add('disabled', () => ({
    components: { Checkbox },
    template: '<checkbox v-bind="$props" :disabled="true"/>',
    props: checkboxArgs
  }))
  .add('hover', () => ({
    components: { Checkbox },
    template: '<checkbox v-bind="$props" :hover="true"/>',
    props: checkboxArgs
  }))
```

In this example, I've defined an object called `checkboxArgs` that includes the `checked`, `disabled`, and `hover` props. 

I've then passed the `checkboxArgs` object to the `props` option in the `add` method for each story. By doing this, you can use the `args` to control the state of the component while creating different stories. 

You can also pass a default value for the props in the object, and you can also add more props as per your requirement.

For example, you can also add a `color` prop that can be used to change the color of the checkbox.
```
const checkboxArgs = {
    checked: {
        type: Boolean,
        default: false
    },
    disabled: {
        type: Boolean,
        default: false
    },
    hover: {
        type: Boolean,
        default: false
    },
    color: {
        type: String,
        default: 'indigo'
    }
}
```

You can now use this `color` prop in your template:
```
template: '<checkbox v-bind="$props" :color="color"/>',
```

By using `args`, you can easily create different variations of your component and test them in a controlled environment.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
