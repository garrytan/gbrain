---
title: "Automated Label Printing Solution"
type: essay
created: 2024-09-06
updated: 2024-09-09
source: chatgpt-export
conversation_id: 0dde2010-2b3d-495d-aafc-48ce47634929
message_count: 61
tags: [chatgpt, import, code, long-form]
---
# Automated Label Printing Solution

> Conversation ID: 0dde2010-2b3d-495d-aafc-48ce47634929
> Created: 2024-09-06T02:58:30Z
> Updated: 2024-09-09T21:05:08Z
> Messages: 61


Hey, how's it going? So, I'm looking to make some labels. And I have labels from Uline. And it's the LaserJet labels, where they have like a sheet of labels. And basically what I want to do is I want to make labels for my bottles of cocktails. So, I need to make labels for the 1-liter bottles that the cocktail is going. So, I have an 18-liter batch of the one cocktail. And I need to make a bunch of labels of that cocktail. So, I'd have 18 1-liter bottles. Each one would need a label. Then, I'd have it for another cocktail. And I have 7 different cocktails total. And this time, I have 18-liter batches. Next time, I'd have 9-liter batches, etc. And every time I make a batch, it's good for 10 days. So, what I need to do is I need to print labels for the 1-liter bottles that say the name of the cocktail. Have a little symbol or emoji. Have a significant color that matches the particular cocktail. It's either a border or a stripe or something. And then I need the date that it was batched and the date that it would expire. And I need this. And then I need to be able to print these every week and modify the date that it's batched. And either have it automatically then update the date it expires or manually update the date it expires. And I'm trying to figure out how I do this with all the variants that I need with the minimal amount of effort. So, either making a Photoshop thing that can easily be updated. Or using some kind of label software. Or if I write a little program. Or if I design a web page with TAML and CSS, which I'm pretty good at. And then I could just do loops for and then modify the number of things. And have a little config page that references the number of cocktails. And then it could also pull in the current date. I would just have to get the formatting to match the template file, the new one. So, I don't know if that's the best way to do it. But looking to have to do the minimal amount of work in the future in order to get new batches done.


The best approach for your labeling project depends on how much flexibility and automation you want. Here's a solution that combines minimal effort with easy updates for future batches:

### 1. **Create a Template in HTML/CSS with JavaScript**  
Since you're comfortable with HTML and CSS, you can create a dynamic label generator using JavaScript. Here's how it would work:
   
- **HTML/CSS**: Create a label design that includes placeholders for the cocktail name, symbol/emoji, color (border or stripe), and dates.
  
- **JavaScript**: Use JavaScript to pull in the current date, calculate the expiration date (current date + 10 days), and allow for easy updating of cocktail names, symbols, and colors.

- **Batch Printing**: Use a `for` loop to generate the correct number of labels based on the batch size. For instance, if you're making an 18-liter batch, the script could generate 18 labels automatically.

#### Example Structure:
- Cocktail names, colors, symbols, etc., can be stored in a JSON file or a configuration object that the script references.
- Date fields can be auto-filled or manually adjusted before printing.

### 2. **Automation with Date Calculation**  
You can automate the date calculation using JavaScript's `Date` object. Every time you print a new batch, it will automatically update the expiration date by adding 10 days to the batch date.

#### Sample JavaScript Snippet:
```javascript
const today = new Date();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);

document.getElementById('batch-date').innerText = today.toLocaleDateString();
document.getElementById('expiration-date').innerText = expirationDate.toLocaleDateString();
```

### 3. **Using a Print Layout Tool (CSS Grid/Flexbox)**  
Design your label layout using CSS Grid or Flexbox to ensure the labels align perfectly on Uline's LaserJet sheets.

### 4. **Optional: Use Photoshop or Illustrator**  
If you prefer design software like Photoshop, you could:
- Create a template with placeholders for text, symbols, and colors.
- Use the "Variables" function in Photoshop to automate text updates (e.g., batch and expiration dates). However, this approach might require manual updating, which is less ideal.

### 5. **Label Software**  
Alternatively, you could use label software (like Avery or Uline’s label-making tools) that allows you to input data manually or use a CSV for batch updates.

### Next Steps:
1. **Choose Between HTML/JavaScript or Photoshop**: If you prefer more control and automation, go with the HTML/JavaScript solution.
2. **Create the Design**: Mock up the label template in your preferred tool.
3. **Automate Updates**: Use JavaScript or another automation tool to handle the date updates.
4. **Test Printing**: Ensure your design aligns with the Uline labels.


I'll use nuxt and tailwind css.

I already have a project setup up. Give me the nuxt component.

Im attaching the template for the labels.


Here’s a Nuxt component you can use to dynamically generate labels with Tailwind CSS. It reads the batch date, calculates the expiration date, and allows you to customize the label per cocktail type.

This component assumes you've set up Nuxt 3 and Tailwind CSS. The labels will be dynamically generated based on the number of bottles (e.g., 18 bottles for a batch). You can modify cocktail names, colors, and symbols as needed. Ensure the layout aligns with your Uline label template.

```vue
<template>
  <div>
    <div v-for="label in labels" :key="label.id" class="label-container">
      <div class="label border-4 p-4 mb-6 rounded-md" :style="{ borderColor: label.color }">
        <h2 class="text-xl font-bold mb-2">{{ label.cocktail }}</h2>
        <div class="text-6xl">{{ label.symbol }}</div>
        <div class="text-lg mt-4">
          <strong>Batch Date:</strong> {{ label.batchDate }}
        </div>
        <div class="text-lg">
          <strong>Expiration Date:</strong> {{ label.expirationDate }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

const labels = ref([
  {
    id: 1,
    cocktail: 'Roaring Rita',  // Example cocktail, change this for each one
    symbol: '🍸',              // Example symbol or emoji
    color: '#ff6347',          // Border color for this cocktail
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: 'Razz Me Up',
    symbol: '🍹',
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  // Add more labels as needed for the different cocktails
]);

</script>

<style scoped>
.label-container {
  width: 100%; /* Modify according to your label sheet layout */
}

.label {
  width: 100%; /* Modify to match the label size */
  height: 200px; /* Example height, adjust based on the label template */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
```

### Key Points:
1. **Cocktail Data**: In this example, there are two cocktails (`Roaring Rita` and `Razz Me Up`). Add the rest by extending the `labels` array.
2. **Symbol/Emoji**: Each label gets its symbol, displayed prominently. You can update or replace these.
3. **Dates**: The batch date is today's date, and the expiration date is automatically calculated to be 10 days later.
4. **Tailwind Styling**: Tailwind CSS is used for styling, such as borders and spacing. Adjust this for finer control based on your label sheet.
5. **Print Optimization**: Test and adjust the sizes to ensure they fit correctly on your labels.

Make sure to adjust the size and layout to align perfectly with your Uline LaserJet label template.


So it should have a print button and the print layout should fit 8.5 x 11 pages that match the label layout. It should also have an input for label number and in this case it will be 19 of each


To meet your needs, I’ve added the following features to the Nuxt component:
1. **Print Button**: Clicking this will trigger the browser’s print dialog.
2. **Dynamic Label Input**: You can specify the number of labels per batch (e.g., 19 of each).
3. **Print Layout**: The layout is optimized to fit an 8.5 x 11-inch page, and you’ll need to fine-tune the size of each label to match your Uline template.

Here’s the updated Nuxt component:

```vue
<template>
  <div>
    <!-- Label Count Input -->
    <label for="labelCount" class="block mb-2 text-lg">Number of Labels Per Batch</label>
    <input 
      v-model="labelCount" 
      id="labelCount" 
      type="number" 
      class="mb-6 border-2 p-2"
      placeholder="Enter number of labels"
    />

    <!-- Print Button -->
    <button @click="printLabels" class="mb-6 bg-blue-500 text-white py-2 px-4 rounded">Print Labels</button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-2 gap-4 print:grid-cols-3 print:gap-2">
      <div 
        v-for="n in labelCount" 
        :key="n" 
        class="label border-4 p-4 rounded-md" 
        :style="{ borderColor: labels[0].color }"
      >
        <h2 class="text-xl font-bold mb-2">{{ labels[0].cocktail }}</h2>
        <div class="text-6xl">{{ labels[0].symbol }}</div>
        <div class="text-lg mt-4">
          <strong>Batch Date:</strong> {{ labels[0].batchDate }}
        </div>
        <div class="text-lg">
          <strong>Expiration Date:</strong> {{ labels[0].expirationDate }}
        </div>
      </div>

      <!-- Repeat for next cocktail -->
      <div 
        v-for="n in labelCount" 
        :key="n + labelCount" 
        class="label border-4 p-4 rounded-md" 
        :style="{ borderColor: labels[1].color }"
      >
        <h2 class="text-xl font-bold mb-2">{{ labels[1].cocktail }}</h2>
        <div class="text-6xl">{{ labels[1].symbol }}</div>
        <div class="text-lg mt-4">
          <strong>Batch Date:</strong> {{ labels[1].batchDate }}
        </div>
        <div class="text-lg">
          <strong>Expiration Date:</strong> {{ labels[1].expirationDate }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels
const labels = ref([
  {
    cocktail: 'Roaring Rita', // Example cocktail
    symbol: '🍸',             // Example symbol/emoji
    color: '#ff6347',         // Border color
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    cocktail: 'Razz Me Up',
    symbol: '🍹',
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  // Add more cocktails here
]);

// Default number of labels (19 for each cocktail)
const labelCount = ref(19);

// Print function to trigger print layout
const printLabels = () => {
  window.print();
};
</script>

<style scoped>
/* Print layout to match 8.5 x 11 inch pages */
@media print {
  body {
    margin: 0;
  }

  #labelSheet {
    page-break-inside: avoid;
    display: grid;
    grid-template-columns: repeat(3, 1fr); /* Adjust for label fit */
    gap: 1rem;
    padding: 1rem;
  }

  .label {
    width: calc(100% - 2rem); /* Adjust based on Uline label size */
    height: 200px; /* Adjust for label size */
    padding: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  width: 100%; /* Modify to match the label size */
  height: 200px; /* Example height, adjust based on the label template */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
```

### Key Updates:
1. **Print Button**: Clicking the "Print Labels" button will trigger the browser’s print dialog, ensuring the labels are laid out on an 8.5 x 11 sheet.
   
2. **Label Count Input**: You can now specify how many labels you want for each cocktail. By default, it’s set to 19 but can be modified.

3. **Print Layout**: The print layout is optimized for an 8.5 x 11-inch sheet using Tailwind’s grid system. The grid is set to 3 columns during print to fit more labels per page (adjust as needed to fit your Uline labels).

### Adjusting to Fit Uline Template:
You may need to tweak the label width and height (`.label`) and the grid configuration in the print media query to match your Uline template perfectly. Adjusting `calc(100% - 2rem)` will allow you to fit labels snugly on the page.

Test this setup by printing to ensure alignment with your label sheet.


We should also use the minaml layout template instead of the default one for this


To use a minimal layout template for your Nuxt app instead of the default one, you can create a minimal layout that bypasses the standard page structure (such as headers, footers, etc.). Here’s how you can do that:

### 1. **Create a Minimal Layout**
In your Nuxt project, create a minimal layout file if you don't already have one.

- Go to your `layouts` directory.
- Create a new layout file called `minimal.vue`.

Here's an example of the `minimal.vue` layout:

```vue
<template>
  <div class="min-h-screen bg-white text-black">
    <nuxt />
  </div>
</template>

<style scoped>
/* Add any global minimal styling you want here */
</style>
```

This will create a blank, clean layout for your printing page without any headers, footers, or other distractions.

### 2. **Assign the Minimal Layout to the Component**
In your component where you generate the labels, tell Nuxt to use the `minimal` layout instead of the default.

Here’s how to do that:

```vue
<script setup>
// Use minimal layout
definePageMeta({
  layout: 'minimal'
});
</script>
```

By adding `definePageMeta({ layout: 'minimal' })`, the page will now use the minimal layout when this component is rendered.

### 3. **CSS and Style Adjustments**
Since you want to ensure that the layout is minimal and the labels fit properly on the page, you can keep most of the layout logic in the component itself (which is already done in the previous steps) and let this minimal layout only handle the background color and basic structure.

Now when you load your label component in the browser and click "Print," it will use this minimal layout without any unnecessary elements, focusing purely on printing the labels efficiently.

Let me know if you need further tweaks or assistance with this!


{'asset_pointer': 'file-service://file-8fil3bgoWdLRYVpatYzMnHPL', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 98, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 8279, 'width': 245}
Here's the spec on the labels so when printed that's the size they should be and there should be 30 per sheet


Based on the label specs you provided—2 5/8" x 1" labels with 30 per sheet—I'll adjust the layout to ensure the labels fit that size and quantity on an 8.5" x 11" page.

Here’s the updated Nuxt component:

### Updated Nuxt Component with Print Layout for 30 Labels Per Sheet (2 5/8" x 1")

```vue
<template>
  <div>
    <!-- Label Count Input -->
    <label for="labelCount" class="block mb-2 text-lg">Number of Labels Per Batch</label>
    <input 
      v-model="labelCount" 
      id="labelCount" 
      type="number" 
      class="mb-6 border-2 p-2"
      placeholder="Enter number of labels"
    />

    <!-- Print Button -->
    <button @click="printLabels" class="mb-6 bg-blue-500 text-white py-2 px-4 rounded">Print Labels</button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1">
      <div 
        v-for="n in labelCount" 
        :key="n" 
        class="label border p-2 rounded-md text-center" 
        :style="{ borderColor: labels[0].color, width: '2.625in', height: '1in' }"
      >
        <h2 class="text-sm font-bold">{{ labels[0].cocktail }}</h2>
        <div class="text-3xl">{{ labels[0].symbol }}</div>
        <div class="text-xs">
          <strong>Batch:</strong> {{ labels[0].batchDate }}
        </div>
        <div class="text-xs">
          <strong>Expires:</strong> {{ labels[0].expirationDate }}
        </div>
      </div>

      <!-- Repeat for next cocktail -->
      <div 
        v-for="n in labelCount" 
        :key="n + labelCount" 
        class="label border p-2 rounded-md text-center" 
        :style="{ borderColor: labels[1].color, width: '2.625in', height: '1in' }"
      >
        <h2 class="text-sm font-bold">{{ labels[1].cocktail }}</h2>
        <div class="text-3xl">{{ labels[1].symbol }}</div>
        <div class="text-xs">
          <strong>Batch:</strong> {{ labels[1].batchDate }}
        </div>
        <div class="text-xs">
          <strong>Expires:</strong> {{ labels[1].expirationDate }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels
const labels = ref([
  {
    cocktail: 'Roaring Rita', // Example cocktail
    symbol: '🍸',             // Example symbol/emoji
    color: '#ff6347',         // Border color
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    cocktail: 'Razz Me Up',
    symbol: '🍹',
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  // Add more cocktails here
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Print function to trigger print layout
const printLabels = () => {
  window.print();
};
</script>

<style scoped>
/* Print layout to match 8.5 x 11 inch pages */
@media print {
  body {
    margin: 0;
  }

  #labelSheet {
    page-break-inside: avoid;
    display: grid;
    grid-template-columns: repeat(3, 2.625in); /* 3 labels per row */
    gap: 0.2in; /* Small gap between labels */
    padding: 0.5in; /* Padding to match label margins */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in;    /* 1 inch tall */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: center;
}
</style>
```

### Key Changes:
1. **Label Dimensions**: Each label is set to `2.625in` width and `1in` height to match the Uline label size.
2. **Print Layout**: The grid now fits 3 labels per row, with 10 rows to fit the total of 30 labels on an 8.5" x 11" page.
3. **Minimal Margins**: A small gap (`0.2in`) is added between labels to ensure the print aligns correctly.

### Print Layout
- The print layout is optimized for 30 labels per page (10 rows, 3 columns).
- Adjust the margin and gap in the CSS if necessary to perfectly align with your Uline sheet.

### Test Print
Once you integrate this component into your Nuxt project, test-print it on a blank sheet to ensure the labels align with your Uline template. You may need to tweak the margins slightly depending on your printer setup.

This setup should make it easy to print your labels each time you create a new batch.


 Great now let's change the label layout so the batch date is larger and the expiration date is tiny. Let's also put the symbol to the left and ll the text to the right. And lets make the border much thicker


Here’s the updated version of the Nuxt component with the changes you requested:

### Key Changes:
1. **Batch Date Larger**: The batch date is now larger for prominence.
2. **Expiration Date Smaller**: The expiration date is much smaller.
3. **Symbol on the Left**: The symbol (emoji) is now positioned on the left side of the label, with the text on the right.
4. **Thicker Border**: The border thickness has been increased for a bolder look.

```vue
<template>
  <div>
    <!-- Label Count Input -->
    <label for="labelCount" class="block mb-2 text-lg">Number of Labels Per Batch</label>
    <input 
      v-model="labelCount" 
      id="labelCount" 
      type="number" 
      class="mb-6 border-2 p-2"
      placeholder="Enter number of labels"
    />

    <!-- Print Button -->
    <button @click="printLabels" class="mb-6 bg-blue-500 text-white py-2 px-4 rounded">Print Labels</button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1">
      <div 
        v-for="n in labelCount" 
        :key="n" 
        class="label border-8 p-2 rounded-md flex items-center" 
        :style="{ borderColor: labels[0].color, width: '2.625in', height: '1in' }"
      >
        <!-- Symbol on the Left -->
        <div class="text-3xl mr-2">{{ labels[0].symbol }}</div>

        <!-- Text on the Right -->
        <div class="text-right">
          <h2 class="text-xs font-bold">{{ labels[0].cocktail }}</h2>
          
          <!-- Batch Date (Larger) -->
          <div class="text-sm font-bold">
            <strong>Batch:</strong> {{ labels[0].batchDate }}
          </div>

          <!-- Expiration Date (Smaller) -->
          <div class="text-xs mt-1">
            <strong>Expires:</strong> {{ labels[0].expirationDate }}
          </div>
        </div>
      </div>

      <!-- Repeat for next cocktail -->
      <div 
        v-for="n in labelCount" 
        :key="n + labelCount" 
        class="label border-8 p-2 rounded-md flex items-center" 
        :style="{ borderColor: labels[1].color, width: '2.625in', height: '1in' }"
      >
        <!-- Symbol on the Left -->
        <div class="text-3xl mr-2">{{ labels[1].symbol }}</div>

        <!-- Text on the Right -->
        <div class="text-right">
          <h2 class="text-xs font-bold">{{ labels[1].cocktail }}</h2>

          <!-- Batch Date (Larger) -->
          <div class="text-sm font-bold">
            <strong>Batch:</strong> {{ labels[1].batchDate }}
          </div>

          <!-- Expiration Date (Smaller) -->
          <div class="text-xs mt-1">
            <strong>Expires:</strong> {{ labels[1].expirationDate }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels
const labels = ref([
  {
    cocktail: 'Roaring Rita', // Example cocktail
    symbol: '🍸',             // Example symbol/emoji
    color: '#ff6347',         // Border color
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    cocktail: 'Razz Me Up',
    symbol: '🍹',
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  // Add more cocktails here
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Print function to trigger print layout
const printLabels = () => {
  window.print();
};
</script>

<style scoped>
/* Print layout to match 8.5 x 11 inch pages */
@media print {
  body {
    margin: 0;
  }

  #labelSheet {
    page-break-inside: avoid;
    display: grid;
    grid-template-columns: repeat(3, 2.625in); /* 3 labels per row */
    gap: 0.2in; /* Small gap between labels */
    padding: 0.5in; /* Padding to match label margins */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in;    /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: space-between;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **Symbol on the Left**: The symbol/emoji is now placed to the left of the label with the text aligned to the right.
2. **Batch Date Larger**: The batch date is styled as `text-sm` and bold for more prominence.
3. **Expiration Date Smaller**: The expiration date is styled as `text-xs` to be significantly smaller.
4. **Thicker Border**: The border width is now `border-8` for a thicker and more noticeable border around the label.
5. **Alignment**: Labels use Flexbox (`flex` and `items-center`) to position the symbol and text side-by-side cleanly.

### Layout
The component now dynamically generates labels that are optimized for a 2.625" x 1" size, with 30 labels per sheet. It also maintains the minimal layout you wanted for printing purposes. 

You can further adjust the spacing, font sizes, or border thickness as needed for a better visual fit once printed.


Lets add
The Password
Giggle Water
Old Sport
Right In The Kisser

Pick an emoji best for each of these. Also change the roaring Rita emoji to a watermelon and the razz me up to either a razzbery or a lemon 


Here's the updated component with your requested cocktails and emojis:

1. **The Password** – 🔑 (Key)
2. **Giggle Water** – 🥂 (Champagne)
3. **Old Sport** – 🎩 (Top Hat)
4. **Right In The Kisser** – 👄 (Lips)
5. **Roaring Rita** – 🍉 (Watermelon)
6. **Razz Me Up** – 🍋 or 🍇 (Lemon or Raspberry – I've chosen the lemon)

### Updated Nuxt Component:

```vue
<template>
  <div>
    <!-- Label Count Input -->
    <label for="labelCount" class="block mb-2 text-lg">Number of Labels Per Batch</label>
    <input 
      v-model="labelCount" 
      id="labelCount" 
      type="number" 
      class="mb-6 border-2 p-2"
      placeholder="Enter number of labels"
    />

    <!-- Print Button -->
    <button @click="printLabels" class="mb-6 bg-blue-500 text-white py-2 px-4 rounded">Print Labels</button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1">
      <div 
        v-for="label in labels" 
        :key="label.id" 
        class="label border-8 p-2 rounded-md flex items-center" 
        :style="{ borderColor: label.color, width: '2.625in', height: '1in' }"
      >
        <!-- Symbol on the Left -->
        <div class="text-3xl mr-2">{{ label.symbol }}</div>

        <!-- Text on the Right -->
        <div class="text-right">
          <h2 class="text-xs font-bold">{{ label.cocktail }}</h2>
          
          <!-- Batch Date (Larger) -->
          <div class="text-sm font-bold">
            <strong>Batch:</strong> {{ label.batchDate }}
          </div>

          <!-- Expiration Date (Smaller) -->
          <div class="text-xs mt-1">
            <strong>Expires:</strong> {{ label.expirationDate }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and colors
const labels = ref([
  {
    id: 1,
    cocktail: 'Roaring Rita', 
    symbol: '🍉',            // Watermelon
    color: '#ff6347',         // Border color
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: 'Razz Me Up',
    symbol: '🍋',            // Lemon
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: 'The Password',
    symbol: '🔑',            // Key
    color: '#8A2BE2',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: 'Giggle Water',
    symbol: '🥂',            // Champagne
    color: '#FFD700',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: 'Old Sport',
    symbol: '🎩',            // Top Hat
    color: '#2F4F4F',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: 'Right In The Kisser',
    symbol: '👄',            // Lips
    color: '#FF4500',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  }
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Print function to trigger print layout
const printLabels = () => {
  window.print();
};
</script>

<style scoped>
/* Print layout to match 8.5 x 11 inch pages */
@media print {
  body {
    margin: 0;
  }

  #labelSheet {
    page-break-inside: avoid;
    display: grid;
    grid-template-columns: repeat(3, 2.625in); /* 3 labels per row */
    gap: 0.2in; /* Small gap between labels */
    padding: 0.5in; /* Padding to match label margins */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in;    /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: space-between;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Changes:
1. **Emoji Updates**: 
   - **Roaring Rita** now uses 🍉 (Watermelon).
   - **Razz Me Up** uses 🍋 (Lemon).
   - **The Password** uses 🔑 (Key).
   - **Giggle Water** uses 🥂 (Champagne).
   - **Old Sport** uses 🎩 (Top Hat).
   - **Right In The Kisser** uses 👄 (Lips).

2. **New Cocktails Added**: Added "The Password," "Giggle Water," "Old Sport," and "Right In The Kisser" to the labels array.

### Print Layout:
- The labels should still fit correctly in a 2.625" x 1" format with 30 labels per sheet. Test the printing to make sure everything is aligned perfectly.
  
Let me know if any further tweaks are needed!


{'asset_pointer': 'file-service://file-WBbz2uJ3QNDdpZuwUHlq2hjP', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 901, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 39659, 'width': 831}
We should remove the input and stuff from the printer version


To hide the input field and print button during printing, we can use a `@media print` CSS rule to hide elements that should not appear in the printed version, like the input box and the button.

Here’s the updated component with the necessary CSS adjustments:

### Updated Component with Hidden Input and Button on Print

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Batch</label>
    <input 
      v-model="labelCount" 
      id="labelCount" 
      type="number" 
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button @click="printLabels" class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print">Print Labels</button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1">
      <div 
        v-for="label in labels" 
        :key="label.id" 
        class="label border-8 p-2 rounded-md flex items-center" 
        :style="{ borderColor: label.color, width: '2.625in', height: '1in' }"
      >
        <!-- Symbol on the Left -->
        <div class="text-3xl mr-2">{{ label.symbol }}</div>

        <!-- Text on the Right -->
        <div class="text-right">
          <h2 class="text-xs font-bold">{{ label.cocktail }}</h2>
          
          <!-- Batch Date (Larger) -->
          <div class="text-sm font-bold">
            <strong>Batch:</strong> {{ label.batchDate }}
          </div>

          <!-- Expiration Date (Smaller) -->
          <div class="text-xs mt-1">
            <strong>Expires:</strong> {{ label.expirationDate }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and colors
const labels = ref([
  {
    id: 1,
    cocktail: 'Roaring Rita', 
    symbol: '🍉',            // Watermelon
    color: '#ff6347',         // Border color
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: 'Razz Me Up',
    symbol: '🍋',            // Lemon
    color: '#ff69b4',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: 'The Password',
    symbol: '🔑',            // Key
    color: '#8A2BE2',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: 'Giggle Water',
    symbol: '🥂',            // Champagne
    color: '#FFD700',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: 'Old Sport',
    symbol: '🎩',            // Top Hat
    color: '#2F4F4F',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: 'Right In The Kisser',
    symbol: '👄',            // Lips
    color: '#FF4500',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  }
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Print function to trigger print layout
const printLabels = () => {
  window.print();
};
</script>

<style scoped>
/* Hide specific elements during print */
@media print {
  .no-print {
    display: none;
  }

  body {
    margin: 0;
  }

  #labelSheet {
    page-break-inside: avoid;
    display: grid;
    grid-template-columns: repeat(3, 2.625in); /* 3 labels per row */
    gap: 0.2in; /* Small gap between labels */
    padding: 0.5in; /* Padding to match label margins */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in;    /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: space-between;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **CSS Class `no-print`**: This class is added to elements that should be hidden during printing, such as the input field and print button. When you trigger the print dialog, these elements will be invisible.
   
2. **Updated CSS for Printing**: The media query `@media print` hides the `no-print` elements and ensures the label grid is aligned perfectly for printing on your 8.5" x 11" sheet with the correct label dimensions.

Now, when you print, the input and print button will not appear on the print preview or the final printout.


Boring Rita is watermelon so make it pink. Razz me up is raspberry so purple. Old sport orange. Kisser red and giggle water green


## See Also
- [[chatgpt/chatgpt_automated-label-printing-solution-part2]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part3]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part4]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part5]]
- [[chatgpt/chatgpt_automated-venue-scheduling-solution]]
