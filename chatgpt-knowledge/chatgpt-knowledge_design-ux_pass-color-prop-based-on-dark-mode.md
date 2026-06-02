---
title: "Pass Color Prop Based on Dark Mode"
type: guide
created: 2022-12-21
updated: 2022-12-21
source: chatgpt-export
topic: design-ux
message_count: 6
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Pass Color Prop Based on Dark Mode

> **Source:** ChatGPT conversation
> **Date:** 2022-12-21T01:31:33Z
> **Messages:** 6
> **Topic:** design-ux

## Question

how can i pass a color prop based on whether or not the user is in dark mode

## Answer

To pass a color prop based on whether or not the user is in dark mode, you can use a ternary operator to check the value of a `darkMode` variable and return a different color value based on its value. Here's an example of how you can do this:

```
const MyComponent = (props) => {
  const { darkMode } = props;

  return (
    <div style={{ color: darkMode ? 'white' : 'black' }}>
      This text will be white if dark mode is enabled, and black if it is not.
    </div>
  );
}
```

In this example, the `darkMode` variable is being destructured from the `props` object and then being used in a ternary operator to determine the value of the `color` style. If `darkMode` is truthy, the color will be set to `white`, and if it is falsy, the color will be set to `black`.

You can also use this technique to pass other styles based on the value of `darkMode`, such as background colors or font sizes.


## Question

this is vue.js. fix it

 <div class="mx-auto flex-col py-6">
          <JovieLogo v-if="$store.state.theme === 'dark'" color="darkMode ?
          'white' : 'black' "" height="80px" />
        </div>

## Answer

Here's how you can pass a color prop based on whether or not the user is in dark mode using Vue.js:

```
<template>
  <div class="mx-auto flex-col py-6">
    <JovieLogo
      v-if="$store.state.theme === 'dark'"
      :color="darkMode ? 'white' : 'black'"
      height="80px"
    />
  </div>
</template>

<script>
export default {
  computed: {
    darkMode() {
      // Return the value of the dark mode state
      return this.$store.state.darkMode;
    },
  },
};
</script>
```

In this example, the `darkMode` computed property is being used to determine the value of the `color` prop passed to the `JovieLogo` component. The value of `darkMode` is determined by accessing the `darkMode` state in the Vuex store.

If you want to use a ternary operator to determine the value of the `color` prop, you can use a template expression inside the `:color` binding like this:

```
:color="darkMode ? 'white' : 'black'"
```

This will pass the value of `'white'` if `darkMode` is truthy, and `'black'` if it is falsy.


## Question

use hex codes instead
and change the value to darkMode from the components data

## Answer

Here's how you can pass a color prop based on whether or not the user is in dark mode using hex codes and the component's data in Vue.js:

```
<template>
  <div class="mx-auto flex-col py-6">
    <JovieLogo
      v-if="$store.state.theme === 'dark'"
      :color="darkMode ? '#ffffff' : '#000000'"
      height="80px"
    />
  </div>
</template>

<script>
export default {
  data() {
    return {
      darkMode: false,
    };
  },
};
</script>
```

In this example, the `darkMode` data property is being used to determine the value of the `color` prop passed to the `JovieLogo` component. The value of `darkMode` is determined by the value of the `darkMode` data property, which is set to `false` by default.

If you want to use a ternary operator to determine the value of the `color` prop, you can use a template expression inside the `:color` binding like this:

```
:color="darkMode ? '#ffffff' : '#000000'"
```

This will pass the value of `'#ffffff'` (white) if `darkMode` is truthy, and `'#000000'` (black) if it is falsy.

