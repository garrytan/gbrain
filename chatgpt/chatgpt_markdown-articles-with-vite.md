---
title: "Markdown Articles with Vite"
type: essay
created: 2024-06-03
updated: 2024-06-03
source: chatgpt-export
conversation_id: b8af11bf-9919-4fa2-8382-6dd47da841b5
message_count: 18
tags: [chatgpt, import, code, long-form]
---
# Markdown Articles with Vite

> Conversation ID: b8af11bf-9919-4fa2-8382-6dd47da841b5
> Created: 2024-06-03T21:46:13Z
> Updated: 2024-06-03T22:34:39Z
> Messages: 18

---

## User

Hey, how's it going? So I have a Vue.js application running on Versal and there's no back end on it. Everything's handled on the front end. We have Vite doing all the builds and currently I have a news page. It's just a Vue template with everything baked in and I want to display a list of articles on that page and then have the articles pulled in separately. I'm trying to figure out if I should do it with markup documents and have it just loop through all the markup documents in a directory or if we should build out separate Vue templates for each article. But I want to minimize the amount of work that I have to do and I want to make it easy to update. So is there a way that we can do it with markup documents that's not crazy because we have no back end? It would have to all be handled with Vite.

---

## Assistant

Hey, Mr. White! Sounds like an interesting project you have there. Since you're aiming to minimize work and ensure easy updates without a backend, using markdown files for your articles can be a good approach. This way, you can keep your content separate from your code and easily update articles without modifying the Vue components.

Here's a basic outline of how you can achieve this:

1. **Store Articles as Markdown Files**: Create a directory in your project (e.g., `src/articles`) where you'll store your markdown files, each representing an article.

2. **Use Vite to Import Markdown Files**: Vite has plugins that can help you import and process markdown files. You can use `vite-plugin-md` to transform markdown files into Vue components.

3. **Create a Vue Component to Render Articles**: This component will fetch and render the markdown files.

Here’s a step-by-step guide:

1. **Install the Markdown Plugin**:
   ```bash
   npm install vite-plugin-md
   ```

2. **Configure Vite to Use the Plugin**:
   In your `vite.config.js`, add the plugin:
   ```javascript
   import { defineConfig } from 'vite';
   import vue from '@vitejs/plugin-vue';
   import Markdown from 'vite-plugin-md';

   export default defineConfig({
     plugins: [
       vue({
         include: [/\.vue$/, /\.md$/], // Process Vue and Markdown files
       }),
       Markdown(),
     ],
   });
   ```

3. **Organize Your Markdown Files**: Place your markdown files in `src/articles`. For example, `article1.md`, `article2.md`, etc.

4. **Create a Component to Display Articles**:
   Create a new Vue component, `Articles.vue`:
   ```html
   <template>
     <div>
       <div v-for="article in articles" :key="article.name">
         <component :is="article.component" />
       </div>
     </div>
   </template>

   <script>
   export default {
     data() {
       return {
         articles: [],
       };
     },
     async created() {
       const articleModules = import.meta.glob('../articles/*.md');
       for (const path in articleModules) {
         const articleComponent = await articleModules[path]();
         this.articles.push({
           name: path,
           component: articleComponent.default,
         });
       }
     },
   };
   </script>
   ```

5. **Route to Your News Page**:
   Ensure you have a route set up for your `Articles.vue` component in your Vue Router configuration.

With this setup, your articles are stored as markdown files, and Vite processes them into Vue components. Your `Articles.vue` component dynamically imports and renders these markdown files, making it easy to add or update articles by simply editing the markdown files.

---

## User

Okay, is that the best way to do it, or is there something else?

---

## Assistant

Using markdown files with Vite and `vite-plugin-md` is one of the best ways to manage content without a backend, especially when you want to keep things simple and easily updatable. However, there are a few other methods you could consider, depending on your specific needs:

1. **Using JSON Files**:
   Store your articles' metadata in a JSON file and the content in markdown files. This way, you can easily manage a list of articles and their details.

   Example JSON file (`src/articles/articles.json`):
   ```json
   [
     {
       "title": "Article 1",
       "path": "/articles/article1.md"
     },
     {
       "title": "Article 2",
       "path": "/articles/article2.md"
     }
   ]
   ```

   Modify your `Articles.vue` to fetch and render articles based on this JSON file:
   ```html
   <template>
     <div>
       <div v-for="article in articles" :key="article.title">
         <h2>{{ article.title }}</h2>
         <component :is="article.component" />
       </div>
     </div>
   </template>

   <script>
   import articles from '../articles/articles.json';

   export default {
     data() {
       return {
         articles: [],
       };
     },
     async created() {
       for (const article of articles) {
         const articleComponent = await import(`../articles/${article.path}`);
         this.articles.push({
           title: article.title,
           component: articleComponent.default,
         });
       }
     },
   };
   </script>
   ```

2. **Static Site Generators**:
   If your site becomes more content-heavy, you might consider using a static site generator like Nuxt.js with the `@nuxt/content` module. This provides a robust framework for handling markdown content and offers features like automatic routing and markdown processing out-of-the-box.

3. **Headless CMS**:
   Integrate a headless CMS like Strapi, Contentful, or Sanity. These services provide a user-friendly interface for managing content and can deliver content via API to your front end. This approach requires more setup but offers powerful content management capabilities.

4. **Manual Vue Components**:
   If you prefer not to use markdown, you can manually create Vue components for each article. This approach provides more flexibility in how content is rendered but requires more work to add or update articles.

Given your requirements of minimizing work and ease of updates, sticking with the markdown files approach using Vite is likely the best balance of simplicity and functionality. It allows you to quickly update content without modifying your Vue components and keeps your project organized.

---

## User

Okay, but what about actual HTML and everything? How are we storing all that in the markdown document?

---

## Assistant

Markdown is quite versatile and can handle HTML directly within the document. This means you can embed actual HTML content alongside markdown syntax to achieve more complex layouts and styling. Here’s how you can do it:

### Example Markdown File with HTML

Let’s assume you have a markdown file named `article1.md` stored in `src/articles/`.

```markdown
# My Article Title

This is a paragraph in markdown.

<div class="custom-class">
  <h2>This is a heading in HTML</h2>
  <p>This is a paragraph inside an HTML div.</p>
  <img src="path/to/image.jpg" alt="Example image">
</div>

Here is another markdown paragraph.
```

### Rendering Markdown with HTML in Vue

With `vite-plugin-md`, the embedded HTML in your markdown files will be processed correctly. Here’s a recap of the setup using the previously discussed approach:

1. **Ensure `vite-plugin-md` is configured**:
   ```javascript
   // vite.config.js
   import { defineConfig } from 'vite';
   import vue from '@vitejs/plugin-vue';
   import Markdown from 'vite-plugin-md';

   export default defineConfig({
     plugins: [
       vue({
         include: [/\.vue$/, /\.md$/], // Process Vue and Markdown files
       }),
       Markdown(),
     ],
   });
   ```

2. **Organize Your Markdown Files**: Place your markdown files in `src/articles`.

3. **Create the Vue Component to Render Articles**:
   ```html
   <template>
     <div>
       <div v-for="article in articles" :key="article.name">
         <component :is="article.component" />
       </div>
     </div>
   </template>

   <script>
   export default {
     data() {
       return {
         articles: [],
       };
     },
     async created() {
       const articleModules = import.meta.glob('../articles/*.md');
       for (const path in articleModules) {
         const articleComponent = await articleModules[path]();
         this.articles.push({
           name: path,
           component: articleComponent.default,
         });
       }
     },
   };
   </script>
   ```

### Using Custom Styles

You can define custom styles for your embedded HTML elements within your Vue component or in your global CSS:

```css
/* src/assets/styles.css */
.custom-class {
  border: 1px solid #ccc;
  padding: 10px;
  margin: 20px 0;
}
```

Ensure you import this CSS file in your main.js or App.vue:

```javascript
// src/main.js
import { createApp } from 'vue';
import App from './App.vue';
import './assets/styles.css';

createApp(App).mount('#app');
```

### Handling Images and Assets

For images and other assets, ensure they are placed in the `public` directory or referenced correctly relative to your project structure. For example, if your images are in `public/images`, you can reference them in your markdown like this:

```markdown
![Example image](/images/example.jpg)
```

### Final Thoughts

By embedding HTML within your markdown, you get the flexibility of markdown simplicity along with the power of HTML for more complex structures. This approach keeps your content highly editable and maintainable, all while being processed efficiently by Vite.

---

## User

Cool story, bro, but I'm using Tailwind CSS.

---

## Assistant

Got it. Tailwind CSS works great with Vue.js and markdown files. Here’s how you can integrate Tailwind CSS with your markdown files and Vue components:

### Ensure Tailwind CSS is Set Up

First, make sure Tailwind CSS is set up in your project. If it's not already set up, you can follow these steps:

1. **Install Tailwind CSS**:
   ```bash
   npm install tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   ```

2. **Configure Tailwind CSS**:
   In your `tailwind.config.js`, specify the paths to all of your template files:
   ```javascript
   module.exports = {
     content: [
       "./index.html",
       "./src/**/*.{vue,js,ts,jsx,tsx,md}",
     ],
     theme: {
       extend: {},
     },
     plugins: [],
   }
   ```

3. **Add Tailwind to your CSS**:
   In your `src/main.css` or equivalent:
   ```css
   @tailwind base;
   @tailwind components;
   @tailwind utilities;
   ```

4. **Import Tailwind in your `main.js`**:
   ```javascript
   import { createApp } from 'vue';
   import App from './App.vue';
   import './main.css';

   createApp(App).mount('#app');
   ```

### Using Tailwind CSS in Markdown Files

With Tailwind CSS set up, you can use its utility classes directly in your markdown files. Here’s an example:

#### Example Markdown File (`src/articles/article1.md`)

```markdown
# My Article Title

This is a paragraph in markdown styled with Tailwind CSS.

<div class="p-4 bg-gray-100 rounded-lg">
  <h2 class="text-xl font-bold">This is a heading in HTML</h2>
  <p class="text-gray-700">This is a paragraph inside an HTML div.</p>
  <img src="/images/example.jpg" alt="Example image" class="mt-4 rounded-lg">
</div>

Here is another markdown paragraph.
```

### Rendering Markdown with Tailwind CSS in Vue

The Vue component setup remains the same. Tailwind CSS classes will be applied as expected:

```html
<template>
  <div>
    <div v-for="article in articles" :key="article.name" class="space-y-4">
      <component :is="article.component" />
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    const articleModules = import.meta.glob('../articles/*.md');
    for (const path in articleModules) {
      const articleComponent = await articleModules[path]();
      this.articles.push({
        name: path,
        component: articleComponent.default,
      });
    }
  },
};
</script>
```

### Summary

With Tailwind CSS, you can leverage its utility-first approach directly in your markdown files, making it easy to style your content. This integration with `vite-plugin-md` allows you to keep your content and styles modular and maintainable.

---

## User

Can you assume that I have a baseline level of intelligence when responding to questions?

---

## Assistant

Absolutely, Mr. White. I’ll keep things concise and straightforward, assuming you're already familiar with the basics. Here’s a streamlined version:

### Integrate Tailwind CSS with Vue and Markdown

1. **Ensure Tailwind CSS is set up**:
   ```bash
   npm install tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   ```

2. **Configure Tailwind** (`tailwind.config.js`):
   ```javascript
   module.exports = {
     content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx,md}"],
     theme: {
       extend: {},
     },
     plugins: [],
   }
   ```

3. **Import Tailwind in your CSS** (`src/main.css`):
   ```css
   @tailwind base;
   @tailwind components;
   @tailwind utilities;
   ```

4. **Include the CSS in your `main.js`**:
   ```javascript
   import { createApp } from 'vue';
   import App from './App.vue';
   import './main.css';

   createApp(App).mount('#app');
   ```

### Using Tailwind in Markdown

Example `article1.md`:

```markdown
# My Article Title

This is a paragraph in markdown.

<div class="p-4 bg-gray-100 rounded-lg">
  <h2 class="text-xl font-bold">HTML Heading</h2>
  <p class="text-gray-700">HTML paragraph inside a div.</p>
  <img src="/images/example.jpg" alt="Example image" class="mt-4 rounded-lg">
</div>

Another markdown paragraph.
```

### Render Markdown with Vue

Vue component to render articles:

```html
<template>
  <div>
    <div v-for="article in articles" :key="article.name" class="space-y-4">
      <component :is="article.component" />
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    const articleModules = import.meta.glob('../articles/*.md');
    for (const path in articleModules) {
      const articleComponent = await articleModules[path]();
      this.articles.push({
        name: path,
        component: article

---

## User

I don't have time to do a full markdown setup right now, so we're just going to go over the View component. So, what's the best way to split this up so that the View components can live in a single directory, and then the News page can pull in all of those components.

---

## Assistant

Understood. If you want to split up the Vue components for each article and pull them into a single News page, you can follow this structure:

### Directory Structure
```
src/
  components/
    articles/
      Article1.vue
      Article2.vue
      ...
  views/
    News.vue
  App.vue
  main.js
```

### Article Component Example (`Article1.vue`)
Each article will be a Vue component stored in `src/components/articles/`.

```html
<template>
  <div class="p-4 bg-gray-100 rounded-lg">
    <h2 class="text-xl font-bold">Article 1 Title</h2>
    <p class="text-gray-700">Content for Article 1.</p>
    <img src="/images/example.jpg" alt="Example image" class="mt-4 rounded-lg">
  </div>
</template>

<script>
export default {
  name: 'Article1',
};
</script>
```

### News Page (`News.vue`)
This component will dynamically import and display all article components.

```html
<template>
  <div class="space-y-4">
    <component v-for="article in articles" :is="article.component" :key="article.name" />
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    const articleModules = import.meta.glob('../components/articles/*.vue');
    for (const path in articleModules) {
      const articleComponent = await articleModules[path]();
      this.articles.push({
        name: path.split('/').pop().replace('.vue', ''),
        component: articleComponent.default,
      });
    }
  },
};
</script>
```

### App.vue
Make sure your `News.vue` component is properly routed.

```html
<template>
  <router-view></router-view>
</template>

<script>
export default {
  name: 'App',
};
</script>
```

### main.js
Ensure you have Vue Router set up to handle the News page route.

```javascript
import { createApp } from 'vue';
import App from './App.vue';
import News from './views/News.vue';
import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', component: News },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

createApp(App).use(router).mount('#app');
```

### Summary
- **Components**: Store each article as a separate Vue component in `src/components/articles/`.
- **News Page**: Dynamically import these components in the `News.vue` file.
- **Routing**: Ensure your Vue Router is set up to route to the News page.

This approach keeps your articles modular and easy to manage within a single directory, while the News page dynamically loads and displays them.

---

## User

This is a good naming convention for our articles. We're going to have articles that are all about music releases, and there will be single releases, album releases, music video releases, etc. for multiple artists. What's the best way to name our files?

---

## Assistant

To maintain a consistent and clear naming convention for your article components, you can use a structured approach that includes the type of release, the artist's name, and the release date. This will make it easier to identify and manage your components.

### Naming Convention

Here’s a suggested naming format:
`Type_ArtistName_ReleaseDate.vue`

- **Type**: Specifies the type of release (`Single`, `Album`, `MusicVideo`)
- **ArtistName**: The name of the artist
- **ReleaseDate**: The release date in `YYYYMMDD` format

### Example Directory Structure

```
src/
  components/
    articles/
      Single_ArtistName_20240101.vue
      Album_ArtistName_20240201.vue
      MusicVideo_ArtistName_20240301.vue
  views/
    News.vue
  App.vue
  main.js
```

### Example Article Component

#### `Single_ArtistName_20240101.vue`

```html
<template>
  <div class="p-4 bg-gray-100 rounded-lg">
    <h2 class="text-xl font-bold">Single Release: Artist Name - Song Title</h2>
    <p class="text-gray-700">Details about the single release...</p>
    <img src="/images/single-cover.jpg" alt="Single Cover" class="mt-4 rounded-lg">
  </div>
</template>

<script>
export default {
  name: 'Single_ArtistName_20240101',
};
</script>
```

### News Page

The `News.vue` component will remain largely the same, dynamically importing and rendering these components:

```html
<template>
  <div class="space-y-4">
    <component v-for="article in articles" :is="article.component" :key="article.name" />
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    const articleModules = import.meta.glob('../components/articles/*.vue');
    for (const path in articleModules) {
      const articleComponent = await articleModules[path]();
      this.articles.push({
        name: path.split('/').pop().replace('.vue', ''),
        component: articleComponent.default,
      });
    }
  },
};
</script>
```

### Summary

By using the `Type_ArtistName_ReleaseDate.vue` naming convention:
- **Type**: Helps identify the release type.
- **ArtistName**: Clarifies which artist the article is about.
- **ReleaseDate**: Ensures articles are easily sortable and identifiable by release date.

This approach will help you keep your project organized and make it easy to find and manage your article components.

---

## User

Here's our current News page with our first article baked into the News page. Extract the article into its own article component, and change the News article to be a template that uses some type of function to import those articles.

<template>
  <div
    class="bg-white sticky top-0 shadow-lg py-4 px-6 flex justify-between items-center"
  >
    <div class="text-xl font-bold text-gray-800">The Bubblegum Factory</div>
    <span class="text-lg font-medium text-gray-600">Newsroom</span>
  </div>

  <div class="bg-white px-6 py-32 lg:px-8">
    <div class="mx-auto max-w-xl text-base leading-7 text-gray-700">
      <h1
        class="mt-2 text-center text-xl border-b pb-8 font-bold tracking-tight text-gray-900 sm:text-2xl"
      >
        <span class="font-bold">Tim White</span> Reveals New Single
        <span class="italic">'Never Say A Word'</span>
      </h1>

      <a class="mx-auto mt-16 py-4" href="https://neversayaword.com">
        <img
          alt="Tim White - Never Say A Word Album Art Teaser"
          loading="lazy"
          class="object-cover mx-auto mt-8 rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
          :src="neverSayAWordAlbumArt"
        />
      </a>
      <div class="mt-10 pb-12 max-w-2xl">
        <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
          New Single <span class="italic">Never Say A Word</span> Set for
          Release June 21st
        </p>

        <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
          Pre-save
          <a
            class="hover:opacity-80 text-blue-600 underline"
            href="https://neversayaword.com"
            >HERE</a
          >
        </p>
        <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
          Download Images and Assets
          <a
            class="hover:opacity-80 text-blue-600 underline"
            href="https://www.dropbox.com/home/Never%20Say%20A%20Word%20-%20Additional%20Assets?share_manage_access=false"
            >HERE</a
          >
        </p>

        <p>
          <span class="font-bold">June 21, 2024 (Los Angeles, CA) - </span>
          Today rising artist <span class="font-bold">Tim White</span> releases
          his new single, <span class="italic">'Never Say A Word'</span> via
          <span class="font-bold">AWAL</span>.
        </p>
        <p class="mt-8">
          “‘<span class="italic">Never Say A Word</span>’ is one of the most
          personal and intense songs I’ve ever written,” shares
          <span class="font-bold">Tim White</span>. “It was inspired by a
          short-lived but incredibly passionate encounter I had with a
          high-profile artist. At the time, she was very publicly dating someone
          else, so we had to keep our connection hidden.”
        </p>
        <p class="mt-8">
          The track opens with electric guitar and White’s evocative vocals
          singing the line "You're kinda hot like me". With mentions of pool
          bars, car crashes, and <span class="font-bold">Jeffree Star</span>,
          the provocative lyrics continue to amplify the song’s sexy, confident
          atmosphere.
        </p>
        <p class="mt-8">
          Co-written with <span class="font-bold">Scott Stallone</span> and
          <span class="font-bold">Tomi Fallenius</span>,
          <span class="italic">'Never Say A Word'</span> marks their third
          collaboration following the success of
          <span class="italic">'Love Don’t Let Me Down'</span> and
          <span class="italic">'Songs About You'</span>. Mixed by
          Grammy-nominated engineer
          <span class="font-bold">Ariel Chobaz</span> and mastered by 9x Grammy
          winner <span class="font-bold">Randy Merrill</span>,
          <span class="italic">'Never Say A Word'</span> is a cool, provocative,
          and confident summer anthem that showcases Tim’s versatility as an
          artist.
        </p>
        <figure class="mt-16">
          <img
            class="aspect-video rounded-xl bg-gray-50 object-cover"
            :src="singerTimWhiteInTheStudio"
            alt="Tim White in the studio"
          />
        </figure>
        <h2 class="mt-16 text-2xl font-bold tracking-tight text-gray-900">
          About <span class="font-bold">Tim White</span>:
        </h2>
        <BioContent />
      </div>
      <div class="border-b py-4">
        <span class="font-bold">Follow Tim White</span>

        <ul class="flex justify-between font-medium mt-4">
          <li class="hover:opacity-80">
            <a href="https://www.tiktok.com/@itstimwhite">TikTok</a>
          </li>
          <li class="hover:opacity-80">
            <a href="https://instagram.com/timwhite">Instagram</a>
          </li>
          <li class="hover:opacity-80">
            <a href="https://www.facebook.com/itstimwhite">Facebook</a>
          </li>
          <li class="hover:opacity-80">
            <a href="https://twitter.com/itstimwhite">Twitter</a>
          </li>
          <li class="hover:opacity-80">
            <a href="https://www.youtube.com/itstimwhite">YouTube</a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import BioContent from "../components/BioContent.vue";
import singerTimWhiteInTheStudio from "./../assets/img/singer_tim_white_in_the_studio.jpg";
import neverSayAWordAlbumArt from "./../assets/img/never-say-a-word-album-art.jpg";
</script>

---

## Assistant

Let's extract the article into its own component and adjust the `News.vue` template to dynamically import and display the articles.

### Article Component

Create a new Vue component for the article in `src/components/articles/`.

#### `Single_TimWhite_NeverSayAWord_20240621.vue`

```html
<template>
  <div class="mx-auto max-w-xl text-base leading-7 text-gray-700">
    <h1 class="mt-2 text-center text-xl border-b pb-8 font-bold tracking-tight text-gray-900 sm:text-2xl">
      <span class="font-bold">Tim White</span> Reveals New Single
      <span class="italic">'Never Say A Word'</span>
    </h1>

    <a class="mx-auto mt-16 py-4" href="https://neversayaword.com">
      <img
        alt="Tim White - Never Say A Word Album Art Teaser"
        loading="lazy"
        class="object-cover mx-auto mt-8 rounded-lg shadow-lg ring-1 ring-black ring-opacity-5"
        :src="neverSayAWordAlbumArt"
      />
    </a>
    <div class="mt-10 pb-12 max-w-2xl">
      <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
        New Single <span class="italic">Never Say A Word</span> Set for Release June 21st
      </p>

      <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
        Pre-save
        <a class="hover:opacity-80 text-blue-600 underline" href="https://neversayaword.com">HERE</a>
      </p>
      <p class="mt-6 font-bold py-4 mx-auto text-center text-lg leading-8">
        Download Images and Assets
        <a class="hover:opacity-80 text-blue-600 underline" href="https://www.dropbox.com/home/Never%20Say%20A%20Word%20-%20Additional%20Assets?share_manage_access=false">HERE</a>
      </p>

      <p>
        <span class="font-bold">June 21, 2024 (Los Angeles, CA) - </span>
        Today rising artist <span class="font-bold">Tim White</span> releases
        his new single, <span class="italic">'Never Say A Word'</span> via
        <span class="font-bold">AWAL</span>.
      </p>
      <p class="mt-8">
        “‘<span class="italic">Never Say A Word</span>’ is one of the most
        personal and intense songs I’ve ever written,” shares
        <span class="font-bold">Tim White</span>. “It was inspired by a
        short-lived but incredibly passionate encounter I had with a
        high-profile artist. At the time, she was very publicly dating someone
        else, so we had to keep our connection hidden.”
      </p>
      <p class="mt-8">
        The track opens with electric guitar and White’s evocative vocals
        singing the line "You're kinda hot like me". With mentions of pool
        bars, car crashes, and <span class="font-bold">Jeffree Star</span>,
        the provocative lyrics continue to amplify the song’s sexy, confident
        atmosphere.
      </p>
      <p class="mt-8">
        Co-written with <span class="font-bold">Scott Stallone</span> and
        <span class="font-bold">Tomi Fallenius</span>,
        <span class="italic">'Never Say A Word'</span> marks their third
        collaboration following the success of
        <span class="italic">'Love Don’t Let Me Down'</span> and
        <span class="italic">'Songs About You'</span>. Mixed by
        Grammy-nominated engineer
        <span class="font-bold">Ariel Chobaz</span> and mastered by 9x Grammy
        winner <span class="font-bold">Randy Merrill</span>,
        <span class="italic">'Never Say A Word'</span> is a cool, provocative,
        and confident summer anthem that showcases Tim’s versatility as an
        artist.
      </p>
      <figure class="mt-16">
        <img class="aspect-video rounded-xl bg-gray-50 object-cover" :src="singerTimWhiteInTheStudio" alt="Tim White in the studio" />
      </figure>
      <h2 class="mt-16 text-2xl font-bold tracking-tight text-gray-900">
        About <span class="font-bold">Tim White</span>:
      </h2>
      <BioContent />
    </div>
    <div class="border-b py-4">
      <span class="font-bold">Follow Tim White</span>

      <ul class="flex justify-between font-medium mt-4">
        <li class="hover:opacity-80">
          <a href="https://www.tiktok.com/@itstimwhite">TikTok</a>
        </li>
        <li class="hover:opacity-80">
          <a href="https://instagram.com/timwhite">Instagram</a>
        </li>
        <li class="hover:opacity-80">
          <a href="https://www.facebook.com/itstimwhite">Facebook</a>
        </li>
        <li class="hover:opacity-80">
          <a href="https://twitter.com/itstimwhite">Twitter</a>
        </li>
        <li class="hover:opacity-80">
          <a href="https://www.youtube.com/itstimwhite">YouTube</a>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import BioContent from "../BioContent.vue";
import singerTimWhiteInTheStudio from "./../../assets/img/singer_tim_white_in_the_studio.jpg";
import neverSayAWordAlbumArt from "./../../assets/img/never-say-a-word-album-art.jpg";
</script>
```

### News Page

Update the `News.vue` to dynamically import article components:

#### `News.vue`

```html
<template>
  <div class="bg-white sticky top-0 shadow-lg py-4 px-6 flex justify-between items-center">
    <div class="text-xl font-bold text-gray-800">The Bubblegum Factory</div>
    <span class="text-lg font-medium text-gray-600">Newsroom</span>
  </div>

  <div class="bg-white px-6 py-32 lg:px-8">
    <div v-for="article in articles" :key="article.name" class="space-y-4">
      <component :is="article.component" />
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    const articleModules = import.meta.glob('../components/articles/*.vue');
    for (const path in articleModules) {
      const articleComponent = await articleModules[path]();
      this.articles.push({
        name: path.split('/').pop().replace('.vue', ''),
        component: articleComponent.default,
      });
    }
  },
};
</script>
```

### Summary

1. **Article Component**: Extracted the article content into `Single_TimWhite_NeverSayAWord_20240621.vue`.
2. **News Page**: Updated to dynamically import and display article components using a loop.

This structure keeps your articles organized and makes it easy to manage them individually.

---

## User

Can you put a sample article in the json so I can test

---

## Assistant

Sure, let's include a sample JSON file to manage your articles and update the News page to load the articles based on this JSON file.

### Sample JSON File

Create a JSON file named `articles.json` in `src/articles/`.

#### `src/articles/articles.json`

```json
[
  {
    "name": "Single_TimWhite_NeverSayAWord_20240621",
    "title": "Tim White Reveals New Single 'Never Say A Word'",
    "path": "../components/articles/Single_TimWhite_NeverSayAWord_20240621.vue"
  }
]
```

### Updated News Page

Modify the `News.vue` component to fetch the article list from the JSON file and dynamically import them.

#### `News.vue`

```html
<template>
  <div class="bg-white sticky top-0 shadow-lg py-4 px-6 flex justify-between items-center">
    <div class="text-xl font-bold text-gray-800">The Bubblegum Factory</div>
    <span class="text-lg font-medium text-gray-600">Newsroom</span>
  </div>

  <div class="bg-white px-6 py-32 lg:px-8">
    <div v-for="article in articles" :key="article.name" class="space-y-4">
      <component :is="article.component" />
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      articles: [],
    };
  },
  async created() {
    // Fetch articles from JSON
    const response = await fetch('../articles/articles.json');
    const articlesList = await response.json();

    for (const article of articlesList) {
      const articleComponent = await import(article.path);
      this.articles.push({
        name: article.name,
        component: articleComponent.default,
      });
    }
  },
};
</script>
```

### Summary

1. **`articles.json`**: Contains the metadata and paths for your articles.
2. **`News.vue`**: Fetches the articles from the JSON file and dynamically imports them.

With this setup, you can add new articles by simply updating the `articles.json` file and adding new Vue components in the `components/articles` directory. This approach keeps your content organized and easily manageable.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
