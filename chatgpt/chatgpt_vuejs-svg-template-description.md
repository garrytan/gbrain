---
conversation_id: 1da46c87-dad7-4cc2-b060-dc0910698b5f
created: 2023-01-08
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js SVG Template Description
type: guide
updated: 2023-01-08
---

# Vue.js SVG Template Description

**Related:** [[coding_web_dev]]

> Conversation ID: 1da46c87-dad7-4cc2-b060-dc0910698b5f
> Created: 2023-01-08T18:15:31Z
> Updated: 2023-01-08T18:15:31Z
> Messages: 4

---

## User

<template>
  <div>
    <router-link :to="link">
      <svg
        v-if="$store.state.theme === 'dark'"
        xmlns="http://www.w3.org/2000/svg"
        :width="width"
        :height="height"
        role="img"
        viewBox="0 0 603 170">
        <title>Jovie</title>
        <path
          fill="#fff"
          fill-rule="evenodd"
          d="M510 118c1 7 3 13 6 16 5 6 10 8 18 8a24 24 0 0 0 21-11l45 5c-7 12-15 20-25 26-10 5-24 7-42 7-16 0-28-2-38-6-9-5-17-12-23-22s-9-21-9-34c0-19 6-34 18-45 12-13 29-18 50-18 17 0 31 2 41 7 10 6 18 13 23 23s8 23 8 39v5h-93Zm38-41c-3-4-9-6-15-6-7 0-13 3-17 9-3 3-5 9-6 16h46c-1-9-4-15-8-19ZM407 46h46v121h-46V46Zm0-45h46v31h-46V1Zm-93 166L264 46h48l24 77 24-77h46l-51 121h-41Zm-54-15a74 74 0 0 1-52 17c-19 0-35-5-47-14a59 59 0 0 1-22-48c0-18 6-34 19-46 12-11 29-17 51-17 23 0 41 7 54 21 10 11 14 25 14 41 0 19-6 34-17 46Zm-35-69c-5-5-9-8-16-8s-13 3-16 8c-5 5-7 13-7 24 0 10 2 18 6 24 4 5 10 7 16 7 7 0 12-2 17-7 4-5 6-14 6-25 0-10-2-18-6-23Zm-117 76c-10 8-23 11-39 11s-29-3-39-7c-9-5-15-11-20-20-6-9-8-20-10-33l49-6 2 16c1 4 3 7 6 9l9 2c5 0 10-2 12-7 3-4 4-11 4-21V1h52v90c0 19-2 33-5 44-4 9-10 17-21 24Z" />
      </svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        :width="width"
        :height="height"
        role="img"
        viewBox="0 0 603 170">
        <title>Jovie</title>
        <path
          :fill="color"
          fill-rule="evenodd"
          d="M510 118c1 7 3 13 6 16 5 6 10 8 18 8a24 24 0 0 0 21-11l45 5c-7 12-15 20-25 26-10 5-24 7-42 7-16 0-28-2-38-6-9-5-17-12-23-22s-9-21-9-34c0-19 6-34 18-45 12-13 29-18 50-18 17 0 31 2 41 7 10 6 18 13 23 23s8 23 8 39v5h-93Zm38-41c-3-4-9-6-15-6-7 0-13 3-17 9-3 3-5 9-6 16h46c-1-9-4-15-8-19ZM407 46h46v121h-46V46Zm0-45h46v31h-46V1Zm-93 166L264 46h48l24 77 24-77h46l-51 121h-41Zm-54-15a74 74 0 0 1-52 17c-19 0-35-5-47-14a59 59 0 0 1-22-48c0-18 6-34 19-46 12-11 29-17 51-17 23 0 41 7 54 21 10 11 14 25 14 41 0 19-6 34-17 46Zm-35-69c-5-5-9-8-16-8s-13 3-16 8c-5 5-7 13-7 24 0 10 2 18 6 24 4 5 10 7 16 7 7 0 12-2 17-7 4-5 6-14 6-25 0-10-2-18-6-23Zm-117 76c-10 8-23 11-39 11s-29-3-39-7c-9-5-15-11-20-20-6-9-8-20-10-33l49-6 2 16c1 4 3 7 6 9l9 2c5 0 10-2 12-7 3-4 4-11 4-21V1h52v90c0 19-2 33-5 44-4 9-10 17-21 24Z" />
      </svg>
    </router-link>
  </div>
</template>
<script>
export default {
  props: {
    width: {
      type: String,
      default: 'auto',
    },
    height: {
      type: String,
      default: '170px',
    },
    color: {
      type: String,
      default: '#334155',
    },
    link: {
      type: String,
      default: '/',
    },
  },
};
</script>


---

## Assistant

This appears to be an SVG (Scalable Vector Graphics) element within a Vue.js template. The SVG element is being used to display a logo. The template includes a `router-link` element that wraps the SVG element and makes the logo a clickable link. The `router-link` component is a Vue.js component that renders an anchor tag with the proper href based on the `to` prop. The `to` prop is bound to the `link` data property of the component. The `v-if` directive is being used to toggle the appearance of the SVG element based on the value of `$store.state.theme`. If `$store.state.theme` is equal to "dark", the SVG element will be rendered with a fill color of "#fff". If `$store.state.theme` is not equal to "dark", the SVG element will be rendered with a fill color specified by the `color` data property of the component.

---

## User

how can i make the svg fill color follow the color of the text set in the div

---

## Assistant

You can bind the `fill` attribute of the SVG element to the `color` property of the component's data object, like this:

```
<template>
  <div>
    <router-link :to="link">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        :width="width"
        :height="height"
        role="img"
        viewBox="0 0 603 170"
        :fill="color"
      >
        <title>Jovie</title>
        <!-- SVG path elements go here -->
      </svg>
    </router-link>
  </div>
</template>

<script>
export default {
  data() {
    return {
      color: "red"
    }
  }
}
</script>
```

Now, the fill color of the SVG element will be the same as the value of the `color` data property. If you want to change the fill color of the SVG element based on the color of the text in the div, you can bind the `color` data property to the `color` style of the div element.

```
<template>
  <div :style="{ color: color }">
    <router-link :to="link">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        :width="width"
        :height="height"
        role="img"
        viewBox="0 0 603 170"
        :fill="color"
      >
        <title>Jovie</title>
        <!-- SVG path elements go here -->
      </svg>
    </router-link>
  </div>
</template>

<script>
export default {
  data() {
    return {
      color: "red"
    }
  }
}
</script>
```

Now, whenever the color of the div's text is changed, the fill color of the SVG element will also be changed to match it.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
