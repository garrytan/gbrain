
Here's how to create a simple, full-screen landing page in Nuxt.js with a logo in the top left corner, hero text in the center, and a copyright notice at the bottom:

### Step 1: Initialize Nuxt.js Project (if not already done)

1. **Create the Nuxt.js Project**
   ```bash
   npx create-nuxt-app jovie
   cd jovie
   ```

2. **Follow the prompts:**
   - Choose your favorite UI framework: Tailwind CSS
   - Choose modules: Axios (optional)
   - Choose linter / formatter: Your preference
   - Choose test framework: Your preference
   - Rendering mode: Universal (SSR)
   - Deployment target: Static
   - Development tools: Your preference

### Step 2: Install Tailwind CSS

1. **Install Tailwind CSS**
   ```bash
   npm install -D tailwindcss@latest postcss@latest autoprefixer@latest
   npx tailwindcss init -p
   ```

2. **Configure Tailwind CSS**
   - Update `tailwind.config.js`:
     ```javascript
     module.exports = {
       purge: ['./components/**/*.{vue,js}', './layouts/**/*.{vue,js}', './pages/**/*.{vue,js}', './plugins/**/*.{js,ts}', './nuxt.config.{js,ts}'],
       darkMode: false,
       theme: {
         extend: {},
       },
       variants: {
         extend: {},
       },
       plugins: [],
     }
     ```

   - Update `assets/css/tailwind.css`:
     ```css
     @tailwind base;
     @tailwind components;
     @tailwind utilities;
     ```

   - Include Tailwind CSS in `nuxt.config.js`:
     ```javascript
     export default {
       css: ['@/assets/css/tailwind.css'],
       buildModules: [
         '@nuxt/postcss8',
       ],
       build: {
         postcss: {
           plugins: {
             tailwindcss: {},
             autoprefixer: {},
           },
         },
       },
     }
     ```

### Step 3: Create the Landing Page

1. **Create the Landing Page Component**
   - Create a new file `pages/index.vue`:
     ```vue
     <template>
       <div class="flex flex-col h-screen justify-between">
         <!-- Header with Logo -->
         <header class="flex justify-start p-4">
           <img src="/logo.png" alt="Logo" class="h-10">
         </header>

         <!-- Hero Section -->
         <main class="flex-grow flex items-center justify-center">
           <h1 class="text-4xl font-bold text-center">Instant smart links for the music industry</h1>
         </main>

         <!-- Footer with Copyright -->
         <footer class="p-4 text-right">
           <p>&copy; {{ currentYear }}</p>
         </footer>
       </div>
     </template>

     <script>
     export default {
       data() {
         return {
           currentYear: new Date().getFullYear()
         }
       }
     }
     </script>

     <style scoped>
     .flex {
       display: flex;
     }
     .h-screen {
       height: 100vh;
     }
     .justify-between {
       justify-content: space-between;
     }
     .items-center {
       align-items: center;
     }
     .text-center {
       text-align: center;
     }
     </style>
     ```

2. **Add a Logo**
   - Place your logo image in the `static` directory. For example, `static/logo.png`.

### Step 4: Deploy to Vercel

1. **Commit and push your changes to a Git repository.**
2. **Connect your repository to Vercel.**
3. **Deploy the project to Vercel.**

This will create a simple, full-screen landing page with a logo in the top left, hero text in the center, and a copyright notice at the bottom. The layout is responsive and centered using Flexbox provided by Tailwind CSS.


<template>
  <div class="flex flex-col h-screen justify-between">
    <!-- Hero Section -->
    <main class="flex-grow flex items-center justify-center">
      <h1 class="text-4xl font-bold text-center">
        Instant smart links for the music industry
      </h1>
    </main>
  </div>
</template>

<script>
export default {
  data() {
    return {
      currentYear: new Date().getFullYear(),
    };
  },
};
</script>

<style scoped>
.flex {
  display: flex;
}
.h-screen {
  height: 100vh;
}
.justify-between {
  justify-content: space-between;
}
.items-center {
  align-items: center;
}
.text-center {
  text-align: center;
}
</style>


Convert to only use tailwind css


Sure, you can use Tailwind CSS classes directly in the template to achieve the desired layout without custom CSS. Here’s the updated version using only Tailwind CSS:

```vue
<template>
  <div class="flex flex-col h-screen justify-between">
    <!-- Header with Logo -->
    <header class="p-4">
      <img src="/logo.png" alt="Logo" class="h-10">
    </header>

    <!-- Hero Section -->
    <main class="flex-grow flex items-center justify-center">
      <h1 class="text-4xl font-bold text-center">
        Instant smart links for the music industry
      </h1>
    </main>

    <!-- Footer with Copyright -->
    <footer class="p-4 text-right">
      <p>&copy; {{ currentYear }}</p>
    </footer>
  </div>
</template>

<script>
export default {
  data() {
    return {
      currentYear: new Date().getFullYear(),
    };
  },
};
</script>

<style>
</style>
```

### Explanation

1. **Header Section:**
   - `p-4`: Padding of 1rem (16px).
   - `h-10`: Height of 2.5rem (40px) for the logo.

2. **Main Section:**
   - `flex-grow`: Allows the main section to grow and take up the remaining space.
   - `flex`: Applies Flexbox layout.
   - `items-center`: Centers items vertically.
   - `justify-center`: Centers items horizontally.
   - `text-4xl`: Font size of 2.25rem (36px).
   - `font-bold`: Bold font weight.
   - `text-center`: Centers text horizontally.

3. **Footer Section:**
   - `p-4`: Padding of 1rem (16px).
   - `text-right`: Aligns text to the right.

This setup ensures a full-screen height layout with centered hero text, a top-left logo, and a bottom-right copyright notice, all using Tailwind CSS classes.


Now let's make a link page in the style of link fire. 


To create a Linkfire-style link page using Nuxt.js and Tailwind CSS, we will create a new page that lists multiple links with some basic styling.

### Step 1: Create the Link Page Component

1. **Create a New Page**
   - Create a new file `pages/artist/_name/index.vue`:
     ```vue
     <template>
       <div class="min-h-screen flex flex-col">
         <!-- Header with Logo -->
         <header class="p-4">
           <img src="/logo.png" alt="Logo" class="h-10">
         </header>

         <!-- Main Content -->
         <main class="flex-grow flex flex-col items-center justify-center bg-gray-100">
           <h1 class="text-3xl font-bold mb-6">{{ artist.name }}</h1>
           <div class="w-full max-w-md mx-auto bg-white p-6 rounded-lg shadow-md">
             <ul>
               <li v-for="link in artist.links" :key="link.url" class="mb-4">
                 <a :href="link.url" target="_blank" class="block p-4 bg-blue-500 text-white text-center rounded hover:bg-blue-600">
                   {{ link.title }}
                 </a>
               </li>
             </ul>
           </div>
         </main>

         <!-- Footer with Copyright -->
         <footer class="p-4 text-right">
           <p>&copy; {{ currentYear }}</p>
         </footer>
       </div>
     </template>

     <script>
     export default {
       async asyncData({ params }) {
         const artist = await fetch(`/api/artists/${params.name}.json`).then(res => res.json());
         return { artist };
       },
       data() {
         return {
           currentYear: new Date().getFullYear(),
         };
       },
     };
     </script>
     ```

2. **Example JSON Structure for Artist Links**
   - Create `static/api/artists/tim.json`:
     ```json
     {
       "name": "Tim",
       "links": [
         { "title": "Seaside Heights", "url": "https://example.com/seaside" },
         { "title": "Another Hit Song", "url": "https://example.com/another-hit" }
       ]
     }
     ```

### Step 2: Update Nuxt.js Configuration

1. **Include Tailwind CSS in `nuxt.config.js`**
   ```javascript
   export default {
     css: ['@/assets/css/tailwind.css'],
     buildModules: [
       '@nuxt/postcss8',
     ],
     build: {
       postcss: {
         plugins: {
           tailwindcss: {},
           autoprefixer: {},
         },
       },
     },
   }
   ```

### Explanation

1. **Header Section:**
   - `p-4`: Padding of 1rem (16px).
   - `h-10`: Height of 2.5rem (40px) for the logo.

2. **Main Section:**
   - `flex-grow`: Allows the main section to grow and take up the remaining space.
   - `flex`: Applies Flexbox layout.
   - `flex-col`: Arranges items in a column.
   - `items-center`: Centers items horizontally.
   - `justify-center`: Centers items vertically.
   - `bg-gray-100`: Light gray background for the main section.
   - `text-3xl`: Font size of 1.875rem (30px) for the artist name.
   - `font-bold`: Bold font weight.
   - `mb-6`: Margin bottom of 1.5rem (24px).
   - `w-full max-w-md mx-auto bg-white p-6 rounded-lg shadow-md`: Styles for the links container.

3. **Links List:**
   - `v-for="link in artist.links"`: Loop through the links array.
   - `block p-4 bg-blue-500 text-white text-center rounded hover:bg-blue-600`: Styles for each link.

4. **Footer Section:**
   - `p-4`: Padding of 1rem (16px).
   - `text-right`: Aligns text to the right.

### Step 3: Deploy to Vercel

1. **Commit and push your changes to a Git repository.**
2. **Connect your repository to Vercel.**
3. **Deploy the project to Vercel.**

By following these steps, you will have a simple and elegant link page styled similarly to Linkfire, using Nuxt.js and Tailwind CSS. This page will display the artist's name and a list of their links, each styled as a button.


**Topic:** [[chatgpt-clusters/jovie_music]]
