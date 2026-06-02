
Here is a simple Vue component using Nuxt.js and Tailwind CSS to display Tim White's core values:

### 1. Install Nuxt.js and Tailwind CSS

First, ensure you have a Nuxt.js project set up. If not, you can create one using:

```bash
npx create-nuxt-app my-project
```

Then, navigate to your project directory and install Tailwind CSS:

```bash
cd my-project
npm install -D tailwindcss@latest postcss@latest autoprefixer@latest
npx tailwindcss init -p
```

Configure Tailwind by updating your `tailwind.config.js` and `assets/css/tailwind.css` as per the [official Tailwind CSS documentation for Nuxt](https://tailwindcss.com/docs/guides/nuxtjs).

### 2. Configure Tailwind CSS

Update `tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './components/**/*.{vue,js}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './nuxt.config.{js,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

Create `assets/css/tailwind.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Update `nuxt.config.js` to include Tailwind CSS:

```javascript
export default {
  css: [
    '@/assets/css/tailwind.css',
  ],
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

### 3. Create the Vue Component

Create a new file `components/CoreValues.vue`:

```vue
<template>
  <div class="p-6 max-w-lg mx-auto bg-white rounded-xl shadow-md space-y-4">
    <h1 class="text-2xl font-bold text-center">Tim White's Core Values</h1>
    <div v-for="(value, index) in coreValues" :key="index" class="space-y-2">
      <h2 class="text-xl font-semibold">{{ index + 1 }}. {{ value.title }}</h2>
      <p class="text-gray-700">{{ value.description }}</p>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      coreValues: [
        {
          title: "Stay alive",
          description: "Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form."
        },
        {
          title: "Be sexy",
          description: "Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room."
        },
        {
          title: "Be so good they can't ignore you",
          description: "Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better."
        },
        {
          title: "Best idea wins",
          description: "Check your ego at the door. Embrace the best ideas, no matter where they come from."
        },
        {
          title: "Move fast & break often",
          description: "Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating."
        },
        {
          title: "Be concise",
          description: "Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life."
        },
        {
          title: "Wake up like a puppy",
          description: "Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity."
        }
      ]
    }
  }
}
</script>

<style scoped>
/* Add any additional styling if necessary */
</style>
```

### 4. Use the Component in a Page

Update `pages/index.vue` to include the `CoreValues` component:

```vue
<template>
  <div>
    <CoreValues />
  </div>
</template>

<script>
import CoreValues from '~/components/CoreValues.vue'

export default {
  components: {
    CoreValues
  }
}
</script>
```

This setup will display Tim White's core values using a simple and clean design with Nuxt.js and Tailwind CSS.


How can we add a printer friendly version


To create a printer-friendly version of the component, you can add a button that toggles a CSS class to adjust the styles for printing. Here’s how you can do it:

### 1. Update the Component with a Print Button

Modify `components/CoreValues.vue` to include a print button and a method to handle the print action:

```vue
<template>
  <div class="p-6 max-w-lg mx-auto bg-white rounded-xl shadow-md space-y-4">
    <div class="text-right">
      <button @click="printPage" class="bg-blue-500 text-white px-4 py-2 rounded">
        Print
      </button>
    </div>
    <h1 class="text-2xl font-bold text-center">Tim White's Core Values</h1>
    <div v-for="(value, index) in coreValues" :key="index" class="space-y-2">
      <h2 class="text-xl font-semibold">{{ index + 1 }}. {{ value.title }}</h2>
      <p class="text-gray-700">{{ value.description }}</p>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      coreValues: [
        {
          title: "Stay alive",
          description: "Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form."
        },
        {
          title: "Be sexy",
          description: "Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room."
        },
        {
          title: "Be so good they can't ignore you",
          description: "Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better."
        },
        {
          title: "Best idea wins",
          description: "Check your ego at the door. Embrace the best ideas, no matter where they come from."
        },
        {
          title: "Move fast & break often",
          description: "Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating."
        },
        {
          title: "Be concise",
          description: "Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life."
        },
        {
          title: "Wake up like a puppy",
          description: "Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity."
        }
      ]
    }
  },
  methods: {
    printPage() {
      window.print();
    }
  }
}
</script>

<style scoped>
/* Add any additional styling if necessary */
@media print {
  body * {
    visibility: hidden;
  }
  .print-area, .print-area * {
    visibility: visible;
  }
  .print-area {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
  }
  button {
    display: none;
  }
}
</style>
```

### 2. Use the Component in a Page

Update `pages/index.vue` to include the `CoreValues` component:

```vue
<template>
  <div class="print-area">
    <CoreValues />
  </div>
</template>

<script>
import CoreValues from '~/components/CoreValues.vue'

export default {
  components: {
    CoreValues
  }
}
</script>
```

### Explanation

1. **Print Button**: The button in the template calls the `printPage` method when clicked. This method uses `window.print()` to open the print dialog.

2. **Print Styles**: The CSS within the `@media print` block ensures only the relevant content is visible when printing. It hides everything else on the page except for the content within the `.print-area` class.

3. **Scoped Styles**: The styles are scoped to the component to ensure they don't affect other parts of the application.

This setup will allow you to print the core values in a clean format without any unnecessary UI elements.


Just use tailwind for the print styling


Here's how you can update the component to use Tailwind CSS for print styling:

### 1. Update the Component with Tailwind Print Classes

Modify `components/CoreValues.vue` to include Tailwind CSS classes for print styling:

```vue
<template>
  <div class="p-6 max-w-lg mx-auto bg-white rounded-xl shadow-md space-y-4 print:max-w-none print:shadow-none print:p-0">
    <div class="text-right print:hidden">
      <button @click="printPage" class="bg-blue-500 text-white px-4 py-2 rounded">
        Print
      </button>
    </div>
    <h1 class="text-2xl font-bold text-center print:text-4xl">Tim White's Core Values</h1>
    <div v-for="(value, index) in coreValues" :key="index" class="space-y-2">
      <h2 class="text-xl font-semibold print:text-3xl">{{ index + 1 }}. {{ value.title }}</h2>
      <p class="text-gray-700 print:text-lg">{{ value.description }}</p>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      coreValues: [
        {
          title: "Stay alive",
          description: "Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form."
        },
        {
          title: "Be sexy",
          description: "Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room."
        },
        {
          title: "Be so good they can't ignore you",
          description: "Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better."
        },
        {
          title: "Best idea wins",
          description: "Check your ego at the door. Embrace the best ideas, no matter where they come from."
        },
        {
          title: "Move fast & break often",
          description: "Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating."
        },
        {
          title: "Be concise",
          description: "Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life."
        },
        {
          title: "Wake up like a puppy",
          description: "Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity."
        }
      ]
    }
  },
  methods: {
    printPage() {
      window.print();
    }
  }
}
</script>

<style scoped>
/* Add any additional styling if necessary */
</style>
```

### Explanation

1. **Tailwind Print Classes**: The Tailwind CSS utility classes like `print:hidden`, `print:max-w-none`, `print:shadow-none`, and `print:p-0` are used to adjust the styles specifically for printing. For example, the print button is hidden during printing using `print:hidden`.

2. **Enhanced Print Styles**: Font sizes are increased for printing to ensure readability (`print:text-4xl` for the title and `print:text-3xl` for subtitles). Additional Tailwind CSS classes can be added or adjusted as necessary to enhance the print layout.

3. **Scoped Styles**: No additional scoped styles are required since Tailwind CSS handles the print styling effectively.

By including Tailwind CSS print utility classes, you can ensure the component is printer-friendly without needing additional CSS.


Adjust our layout component to hide the menu and buttons on printing

<template>
  <div class="flex flex-col justify-between h-screen bg-white">
    <Navbar class="fixed top-0" />
    <slot></slot>
    <footer class="flex justify-between items-center text-black text-xs p-4">
      <span class="font-bold text-slate-500"
        >&copy; {{ new Date().getFullYear() }}</span
      >
    </footer>
  </div>
</template>
<script setup>
import Navbar from "@/components/Navbar.vue";
</script>


To adjust the layout component to hide the menu and buttons on printing, you can use Tailwind CSS print utility classes. Here’s how you can update the layout component:

### Update the Layout Component

Modify the layout component to include the Tailwind CSS print utility classes:

```vue
<template>
  <div class="flex flex-col justify-between h-screen bg-white">
    <Navbar class="fixed top-0 print:hidden" />
    <slot></slot>
    <footer class="flex justify-between items-center text-black text-xs p-4 print:hidden">
      <span class="font-bold text-slate-500">&copy; {{ new Date().getFullYear() }}</span>
    </footer>
  </div>
</template>

<script setup>
import Navbar from "@/components/Navbar.vue";
</script>
```

### Explanation

1. **Hide Navbar on Print**: The `print:hidden` class is added to the `Navbar` component to ensure it is hidden when printing.

2. **Hide Footer on Print**: Similarly, the `print:hidden` class is added to the `footer` element to hide it during printing.

With these changes, the Navbar and footer will be hidden when you print the page, making the printed content cleaner and free of unnecessary UI elements.


I think we need to include the concept that something are not worth doing. We want to focus. We want to do the things that matter most. But anything worth doing is worth doing well. We dont fix problems whose solution is costly but benefit is small. We prioritize things by impact and importance for amount of effort and time required. We choose wisely what to do. But when we choose to do it we choose do it as best as it can be done. But if at any point circumstances change and it no longer is cost effective or beneficial to do it, we drop it. 

Lets add that concept in by augmented the ideas already there to include the sentiment. We still should keep to th 7 core values. 


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better. Focus on what matters most and choose wisely what to do. Prioritize tasks by impact and importance relative to the effort and time required. Drop tasks if they are no longer cost-effective or beneficial.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.


Maybe it would be better as its own value "focus"


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Focus on what matters most and choose wisely what to do. Prioritize tasks by impact and importance relative to the effort and time required. Drop tasks if they are no longer cost-effective or beneficial. Let everything you do be done with excellence.


For 8 drop tasks....REGARDLESS OF HOW MUCH SUNK COST ALREADY EXISTS


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Focus on what matters most and choose wisely what to do. Prioritize tasks by impact and importance relative to the effort and time required. Drop tasks if they are no longer cost-effective or beneficial, regardless of how much sunk cost already exists. Let everything you do be done with excellence.


Also add another for systemize everything.

Also we should combine effort where possible to further hone in focus. For example. If we're going to spend time working out, we should film it so we also get social media content. That hour of time now costs less because we got 2 benefits from it rather than one. every thing we do or spend time on should benegit multiple disciplines in our life. We shouldn't dilute our efforts by doing 20 things that dont help each other but rather I should taking acting jobs that will drive traffic to music or spend time bartending if it means I get to network with people in the entertainment industry, etc. rather than taking a job where I only get money from it. We should always be building equity in ourselves. Doing things that increase our value and skillset and that can carry over. Nothing should ever be done for a 1 to 1 output but rather should have asymmetric returns.

And on 8 kill the excellence line because we already have that in 3


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Focus on what matters most and choose wisely what to do. Prioritize tasks by impact and importance relative to the effort and time required. Drop tasks if they are no longer cost-effective or beneficial, regardless of how much sunk cost already exists. Combine efforts where possible to maximize benefits and build equity in yourself. Ensure every action has asymmetric returns, increasing your value and skillset across multiple disciplines.

9. **Systemize everything**  
   Create systems and processes for all aspects of life. Streamline activities to ensure efficiency and consistency. Systemization helps maintain focus, reduces errors, and frees up mental energy for creativity and growth.


9 kill the last line. add in something about how when you have a working solution, automate yourself out if so you're cognitive bandwidth can focus on the next set of problems. We should be abstracting our thinking away from low level problems as much as possible. We should be utilizing automation and systems to minimize how much time we waste in life. Repetitive tasks are beneath us and our brains are meant for so much more. Dont waste your time doing the same thing over and over again 


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Focus on what matters most and choose wisely what to do. Prioritize tasks by impact and importance relative to the effort and time required. Drop tasks if they are no longer cost-effective or beneficial, regardless of how much sunk cost already exists. Combine efforts where possible to maximize benefits and build equity in yourself. Ensure every action has asymmetric returns, increasing your value and skillset across multiple disciplines.

9. **Systemize everything**  
   Create systems and processes for all aspects of life. When you have a working solution, automate yourself out so your cognitive bandwidth can focus on the next set of problems. Abstract your thinking away from low-level problems as much as possible. Utilize automation and systems to minimize wasted time. Repetitive tasks are beneath you; your brain is meant for much more. Don’t waste time doing the same thing over and over again.


Great now make 8 and 9 more concise and eloquent and evolved but keep all of the current idea and principle intact


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Concentrate on high-impact tasks. Drop those no longer beneficial, regardless of sunk costs. Combine efforts to maximize benefits and build equity in yourself. Ensure every action has asymmetric returns, enhancing your value and skills across multiple disciplines.

9. **Systemize everything**  
   Develop systems and processes for all aspects of life. Automate solutions to free cognitive bandwidth for new challenges. Abstract away from low-level problems and minimize wasted time through automation. Repetitive tasks are beneath you; focus on higher-level thinking.


Get real. 
Our last one should focus on being authentic and true to what makes us happy. Existing in the real world, dealing with real problems, talking o real people. We should be grounded in reality and not get lost in our head. We should ensure that we go outside everyday, that we talk to real people and that we remember what matters. We should not get caught up in something that won't matter at all in 10, 20, 30 years. We should be honest, and straight forward. We should not obfuscate. We should be clear about what we want and go get it.


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Concentrate on high-impact tasks. Drop those no longer beneficial, regardless of sunk costs. Combine efforts to maximize benefits and build equity in yourself. Ensure every action has asymmetric returns, enhancing your value and skills across multiple disciplines.

9. **Get real**  
   Be authentic and true to what makes you happy. Exist in the real world, dealing with real problems and talking to real people. Stay grounded in reality and avoid getting lost in your head. Go outside every day, talk to real people, and remember what truly matters. Don't get caught up in things that won't matter in 10, 20, or 30 years. Be honest and straightforward. Be clear about what you want and go get it.


Great now reword 9 to be more concise, evolved, and eloquent, but keep the existing principles in tact


Tim White's core values, reworded as commands for personal life:

1. **Stay alive**  
   Prioritize your survival and well-being. Evaluate all potential negative outcomes and side effects of your decisions. Mitigate risks to ensure that even the worst-case scenario does not compromise your physical or mental health. Strive to thrive, not merely exist, embracing life in its fullest form.

2. **Be sexy**  
   Value attractiveness at the highest level. You’re judged by your appearance first. Don’t let your work be dismissed because of poor presentation. Maintain a sexy body, outfit, and personality. Take sexy photos, use sexy designs, write sexy songs. Make people interested in what you have to say or contribute by being the sexiest thing in every room.

3. **Be so good they can't ignore you**  
   Work hard. Let everything you do be done with excellence. Even the most basic tasks should be done at the highest level. If you're already the best, be better.

4. **Best idea wins**  
   Check your ego at the door. Embrace the best ideas, no matter where they come from.

5. **Move fast & break often**  
   Act quickly with a bias for action. Regularly step back to see how your efforts fit into the bigger picture. Embrace a cycle of sprinting, walking, and repeating.

6. **Be concise**  
   Use simple and concise language in all aspects of life. Opt for concise design, code, texts, fonts, diets, workouts, melodies, and coffee orders. Stick to what serves a function and eliminate what doesn't, both in your work and in your life.

7. **Wake up like a puppy**  
   Start each day with a clean slate, brimming with excitement and curiosity. Embrace the new day with a sense of wonder, free from the burdens of past emotions. Address problems from first principles and maintain a fresh perspective to ensure that every day is met with renewed enthusiasm and clarity.

8. **Focus**  
   Concentrate on high-impact tasks. Drop those no longer beneficial, regardless of sunk costs. Combine efforts to maximize benefits and build equity in yourself. Ensure every action has asymmetric returns, enhancing your value and skills across multiple disciplines.

9. **Get real**  
   Be authentic and true to what makes you happy. Stay grounded in reality and engage with the real world. Go outside, talk to real people, and focus on what truly matters. Avoid getting caught up in things that won’t matter in the long run. Be honest and straightforward about your desires and pursue them with clarity.


Finally 10. Own it. Write a concise value about taking ownership and never falling into a victim mindset. Being in control of your lfie and decisions, always understanding that your fate is in your hands and if you dont like your situation you go change it.
