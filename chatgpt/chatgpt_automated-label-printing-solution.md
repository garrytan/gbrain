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

---

## User

Hey, how's it going? So, I'm looking to make some labels. And I have labels from Uline. And it's the LaserJet labels, where they have like a sheet of labels. And basically what I want to do is I want to make labels for my bottles of cocktails. So, I need to make labels for the 1-liter bottles that the cocktail is going. So, I have an 18-liter batch of the one cocktail. And I need to make a bunch of labels of that cocktail. So, I'd have 18 1-liter bottles. Each one would need a label. Then, I'd have it for another cocktail. And I have 7 different cocktails total. And this time, I have 18-liter batches. Next time, I'd have 9-liter batches, etc. And every time I make a batch, it's good for 10 days. So, what I need to do is I need to print labels for the 1-liter bottles that say the name of the cocktail. Have a little symbol or emoji. Have a significant color that matches the particular cocktail. It's either a border or a stripe or something. And then I need the date that it was batched and the date that it would expire. And I need this. And then I need to be able to print these every week and modify the date that it's batched. And either have it automatically then update the date it expires or manually update the date it expires. And I'm trying to figure out how I do this with all the variants that I need with the minimal amount of effort. So, either making a Photoshop thing that can easily be updated. Or using some kind of label software. Or if I write a little program. Or if I design a web page with TAML and CSS, which I'm pretty good at. And then I could just do loops for and then modify the number of things. And have a little config page that references the number of cocktails. And then it could also pull in the current date. I would just have to get the formatting to match the template file, the new one. So, I don't know if that's the best way to do it. But looking to have to do the minimal amount of work in the future in order to get new batches done.

---

## Assistant

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

---

## User

I'll use nuxt and tailwind css.

I already have a project setup up. Give me the nuxt component.

Im attaching the template for the labels.

---

## Assistant

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

---

## User

So it should have a print button and the print layout should fit 8.5 x 11 pages that match the label layout. It should also have an input for label number and in this case it will be 19 of each

---

## Assistant

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

---

## User

We should also use the minaml layout template instead of the default one for this

---

## Assistant

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

---

## User

{'asset_pointer': 'file-service://file-8fil3bgoWdLRYVpatYzMnHPL', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 98, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 8279, 'width': 245}
Here's the spec on the labels so when printed that's the size they should be and there should be 30 per sheet

---

## Assistant

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

---

## User

 Great now let's change the label layout so the batch date is larger and the expiration date is tiny. Let's also put the symbol to the left and ll the text to the right. And lets make the border much thicker

---

## Assistant

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

---

## User

Lets add
The Password
Giggle Water
Old Sport
Right In The Kisser

Pick an emoji best for each of these. Also change the roaring Rita emoji to a watermelon and the razz me up to either a razzbery or a lemon 

---

## Assistant

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

---

## User

{'asset_pointer': 'file-service://file-WBbz2uJ3QNDdpZuwUHlq2hjP', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 901, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 39659, 'width': 831}
We should remove the input and stuff from the printer version

---

## Assistant

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

---

## User

Boring Rita is watermelon so make it pink. Razz me up is raspberry so purple. Old sport orange. Kisser red and giggle water green

---

## Assistant

Got it! I've updated the colors for each cocktail as per your request:

1. **Boring Rita** – Pink (#FF69B4)
2. **Razz Me Up** – Purple (#800080)
3. **Old Sport** – Orange (#FFA500)
4. **Right In The Kisser** – Red (#FF0000)
5. **Giggle Water** – Green (#008000)

Here’s the updated Nuxt component:

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

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: 'Boring Rita',  // Formerly Roaring Rita
    symbol: '🍉',             // Watermelon
    color: '#FF69B4',         // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: 'Razz Me Up',
    symbol: '🍇',             // Raspberry
    color: '#800080',         // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: 'The Password',
    symbol: '🔑',             // Key
    color: '#8A2BE2',
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: 'Giggle Water',
    symbol: '🥂',             // Champagne
    color: '#008000',         // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: 'Old Sport',
    symbol: '🎩',             // Top Hat
    color: '#FFA500',         // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: 'Right In The Kisser',
    symbol: '👄',             // Lips
    color: '#FF0000',         // Red
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

### Key Color Updates:
1. **Boring Rita** – Pink (`#FF69B4`)
2. **Razz Me Up** – Purple (`#800080`)
3. **Old Sport** – Orange (`#FFA500`)
4. **Right In The Kisser** – Red (`#FF0000`)
5. **Giggle Water** – Green (`#008000`)

### What’s Next:
You can now print labels with these updated color codes for your cocktails. As before, all non-essential elements (like input fields and buttons) will be hidden during printing.

Let me know if you need any further adjustments!

---

## User

This is great:

<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print"
      >Number of Labels Per Batch</label
    >
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1"
    >
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
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
    height: 1in; /* 1 inch tall */
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


Just make sure it's actually showing X number of labels for each cocktail. Its currently only showing one of each

---

## Assistant

To ensure that the labels for each cocktail are repeated based on the number you specify (e.g., 30 labels for each cocktail), we need to adjust how the labels are generated in the `v-for` loop. Instead of iterating directly over the `labels` array, we can use a loop that repeats the cocktail labels the correct number of times.

Here's the updated component:

### Updated Component to Repeat Labels for Each Cocktail:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-2 print:grid-cols-3 print:gap-1"
    >
      <div
        v-for="label in generateLabels()"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    height: 1in; /* 1 inch tall */
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
1. **`generateLabels` Function**: This function creates the correct number of labels per cocktail. It loops through each cocktail and duplicates it according to the `labelCount` value (default is 30). This ensures that if you specify 30 labels per batch, you will get 30 labels for each cocktail.
2. **Dynamic ID**: Each label is given a unique ID by combining its cocktail `id` with the loop index to avoid duplicate keys.

### Expected Behavior:
- If you set the number of labels to 30, it will generate 30 labels for each cocktail in the list, all of which will be printed in the grid.
- You can modify the number of labels via the input box, and it will update the number of labels for each cocktail accordingly.
  
This should now work as expected and print the correct number of labels for each cocktail! Let me know if you need any further tweaks.

---

## User

{'asset_pointer': 'file-service://file-kxwR06JVqprDW0LMRockKpjV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 751, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 553418, 'width': 1082}

---

## Assistant

It seems the labels are generating correctly, but you're seeing multiple pages (7 sheets of paper) instead of fitting all 30 labels on a single 8.5" x 11" page.

This issue can be caused by several factors, including the margins or spacing in the grid layout. I'll make the following adjustments to try to fit 30 labels on a single page (10 rows and 3 columns) within the 8.5" x 11" size:

### Updated Component for Proper Fit on a Single Page

Here’s the updated version that should fit 30 labels (3 columns and 10 rows) on a single 8.5" x 11" page:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-0.1 print:grid-cols-3 print:gap-0.1"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    gap: 0.1in; /* Small gap between labels */
    padding: 0.2in; /* Small padding to fit in 8.5x11 layout */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Adjustments:
1. **Reduced Gaps**: I reduced the gaps between labels (`gap: 0.1in`) and padding (`padding: 0.2in`) to help fit the labels correctly on one page.
2. **Reduced Border Size**: I decreased the border size to `border-4` to reduce spacing and allow more labels per page.
3. **Grid Layout**: The grid is set to 3 columns and will automatically place labels in rows, keeping the size at 2.625" x 1" to match your label specs.

### What to Do:
- Try printing again with this updated layout to see if the labels now fit correctly on one 8.5" x 11" sheet.
- Make sure to print in "Actual Size" or 100% scale to ensure the labels align properly with your Uline sheets.

Let me know how this works!

---

## User

So it seems the template has a slight margin on top and bottom and 0 vertical gap between labels while it has a slight horizontal gap.

Im including the pdf of the template again so you can see 

---

## Assistant

To match the template (S-8080) that has a slight margin at the top and bottom, no vertical gap between labels, and a slight horizontal gap between columns, I’ll adjust the layout and spacing accordingly. 

Here’s the updated version of the component, including the correct margins and gaps based on your description:

### Updated Component with Correct Margins and Gaps:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-x-0.2 print:grid-cols-3 print:gap-x-0.2 print:gap-y-0"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    gap-x: 0.2in; /* Slight horizontal gap between labels */
    gap-y: 0; /* No vertical gap */
    padding-top: 0.25in; /* Small top margin */
    padding-bottom: 0.25in; /* Small bottom margin */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Adjustments:
1. **Vertical Gap**: Removed the vertical gap between labels (`gap-y: 0`), matching the template layout.
2. **Horizontal Gap**: Applied a small horizontal gap (`gap-x: 0.2in`) between columns to match the template.
3. **Top and Bottom Margins**: Added slight top and bottom padding (`padding-top: 0.25in` and `padding-bottom: 0.25in`) to match the margin you mentioned.

This should now align with the template's margins and gaps more accurately. Please try printing again to ensure it fits correctly on your label sheet.

Let me know if any further tweaks are needed!

---

## User

Add flapper fire as a cocktail and make it yellow with a fire emoji

---

## Assistant

Here’s the updated version of the component, including the new cocktail **Flapper Fire**, with a yellow border and a fire emoji:

### Updated Component:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-x-0.2 print:grid-cols-3 print:gap-x-0.2 print:gap-y-0"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    gap-x: 0.2in; /* Slight horizontal gap between labels */
    gap-y: 0; /* No vertical gap */
    padding-top: 0.25in; /* Small top margin */
    padding-bottom: 0.25in; /* Small bottom margin */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Additions:
- **Flapper Fire**:
  - **Color**: Yellow (`#FFD700`)
  - **Symbol**: Fire (`🔥`)

You should now see the **Flapper Fire** cocktail with the appropriate color and symbol in the list of labels. Let me know if any further adjustments are needed!

---

## User

Increase the horizontal gap in print view and make sure its horizontally centered, currently the margin on the right is large and on the left it doesnt exist

---

## Assistant

To ensure the labels are horizontally centered and the horizontal gap between labels is larger, we'll adjust the grid layout to provide equal margins on both sides, and we'll increase the horizontal gap.

### Updated Component with Horizontal Centering and Larger Gap:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-x-0.4 print:grid-cols-3 print:gap-x-0.4 mx-auto"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    gap-x: 0.4in; /* Larger horizontal gap between labels */
    gap-y: 0; /* No vertical gap */
    padding-top: 0.25in; /* Small top margin */
    padding-bottom: 0.25in; /* Small bottom margin */
    justify-content: center; /* Horizontally center the labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Adjustments:
1. **Horizontal Centering**: The labels are now horizontally centered using `justify-content: center` in the `#labelSheet` div.
2. **Larger Horizontal Gap**: The horizontal gap between labels has been increased to `0.4in` to better match the template.
3. **Equal Margins**: Ensured that there are equal left and right margins to make sure the labels are centered on the page.

### What to Do:
- Try printing again with these adjustments, and make sure to print at 100% scale.
  
This should now correct the uneven margin issue and ensure the labels are centered with the appropriate gaps. Let me know if this resolves the issue or if you need further tweaks!

---

## User

{'asset_pointer': 'file-service://file-Kk6rZCJDzah3ROaXHmxgTGgc', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 627, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 362892, 'width': 693}
The second page and first page have different top margins. The second page has none

---

## Assistant

It looks like the issue is that the top margin is not being consistently applied across multiple pages during printing. This can happen if the `padding-top` is only applied on the first page but not repeated on subsequent pages.

To ensure consistent margins across all pages, we need to use the `page-break` and `margin` CSS rules to force consistent top margins on all pages.

### Updated Component with Consistent Top Margins Across Pages:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-x-0.4 print:grid-cols-3 print:gap-x-0.4 mx-auto"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDate = new Date();
expirationDate.setDate(today.getDate() + 10);
const formattedExpiration = expirationDate.toLocaleDateString();

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: formattedExpiration,
  },
]);

// Default number of labels (30 for each cocktail, matching label sheet spec)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

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
    gap-x: 0.4in; /* Larger horizontal gap between labels */
    gap-y: 0; /* No vertical gap */
    padding: 0.25in 0.4in; /* Small top/bottom and horizontal margins */
    margin-top: 0.5in; /* Consistent top margin for each page */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Adjustments:
1. **Consistent Top Margin for All Pages**: The `margin-top: 0.5in` has been applied to the `#labelSheet` to ensure that each printed page has the same top margin.
2. **Padding and Margin**: I added a combination of `padding` and `margin` to ensure proper alignment and spacing for each page.

### Expected Behavior:
- All pages will now have a consistent top margin, ensuring that the labels are evenly distributed across all pages during printing.

Try printing with this adjustment, and let me know if it fixes the issue with inconsistent top margins!

---

## User

My minimal template is set to this:

<template>
  <div class="flex flex-col justify-between h-screen bg-white">
    <slot></slot>
  </div>
</template>

Let me know if this Is effecting the printed view at all and if it should be changed


---

## Assistant

The template you shared for your **minimal layout** is a standard flexbox-based layout that stretches the content to fill the entire height of the screen (`h-screen`). This could potentially be affecting the printed view by trying to ensure the content spans the entire height of the screen, which might cause issues with page breaks and margins when printing.

### Possible Issues with the Current Template:
1. **`h-screen`**: The `h-screen` class forces the height to always match the viewport height (on screen), which might interfere with natural page breaks in printing.
2. **`flex` layout**: Using `flexbox` to distribute content across the full height may not be ideal for printing, where page layout depends on content flowing naturally across multiple pages, rather than filling a fixed-height container.

### Solution:
You can modify the minimal layout specifically for print scenarios by ensuring that it uses a more natural layout that doesn't stretch the height or force elements into a flex layout.

Here’s an updated version of the **minimal layout** with print-safe adjustments:

### Updated Minimal Layout for Print:

```vue
<template>
  <div class="print:static flex flex-col justify-between bg-white">
    <slot></slot>
  </div>
</template>

<style scoped>
@media print {
  .flex {
    display: block; /* Disable flexbox in print view */
  }

  .print\:static {
    position: static; /* Ensure content flows naturally for print */
    height: auto; /* Remove any height constraints for print */
  }
}
</style>
```

### Key Adjustments:
1. **Disable Flexbox in Print**: By setting `.flex { display: block; }` in the `@media print` section, you ensure the content flows naturally in the print view instead of using flexbox layout.
2. **Remove `h-screen` and Static Height for Print**: The `print:static` class will ensure that height is auto-managed during printing. It removes any height constraints (`h-screen`) and allows the page to naturally break where needed.

### How This Helps:
- This removes any unintended behavior from flexbox or height constraints that might be affecting how content breaks across pages during printing.
- The layout will now behave more like a block-based flow layout, which is better suited for printing multiple pages of content.

You can try this updated layout, and it should prevent any issues from flexbox or height constraints affecting the printed view. Let me know if this resolves the issue or if you notice any improvements!

---

## User

Make the value 10 (for difference between date and expiration) a variable that we set like the number of labels

---

## Assistant

To make the expiration period (currently set to 10 days) a dynamic value, similar to how the number of labels is set, you can introduce an input field to allow the user to specify the number of days between the batch date and the expiration date.

Here’s how you can update the component to include a dynamic expiration period:

### Updated Component:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Expiration Days Input (Hidden during print) -->
    <label for="expirationDays" class="block mb-2 text-lg no-print">Days Until Expiration</label>
    <input
      v-model="expirationDays"
      id="expirationDays"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter days until expiration"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 gap-x-0.4 print:grid-cols-3 print:gap-x-0.4 mx-auto"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();

// Variables for dynamic number of labels and expiration days
const labelCount = ref(30); // Default number of labels
const expirationDays = ref(10); // Default 10 days until expiration

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date();
  expirationDate.setDate(today.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Boring Rita", // Formerly Roaring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value), // Dynamically calculated expiration date
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥂", // Champagne
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
]);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

// Print function to trigger print layout
const printLabels = () => {
  labels.value.forEach((label) => {
    label.expirationDate = calculateExpirationDate(expirationDays.value); // Update expiration date before printing
  });
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
    gap-x: 0.4in; /* Larger horizontal gap between labels */
    gap-y: 0; /* No vertical gap */
    padding: 0.25in 0.4in; /* Small top/bottom and horizontal margins */
    margin-top: 0.5in; /* Consistent top margin for each page */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
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

### Key Additions:
1. **Expiration Days Input**: I’ve added an input field where you can specify the number of days until the labels expire.
2. **Dynamic Expiration Date**: The expiration date is dynamically calculated based on the input value (`expirationDays`), with a default of 10 days.
3. **Expiration Date Calculation Function**: The `calculateExpirationDate` function handles the logic to compute the expiration date dynamically.

### Workflow:
1. Enter the number of labels per batch.
2. Enter the number of days until expiration.
3. Click "Print Labels," and the labels will be generated with the correct expiration date.

Let me know how this works for you!

---

## User

Every page should have a .5in margin top and Botton and a .25in margin left and right. The labels columns should be 3 with the left and right being justified to the outside with no margin or padding and the center one center. no gap between labels horizantally. And that should result in a 8.5/11 page having 30 labels

Also boring rita is the roaring rita.
cucumber emoji for Giggle Water


---

## Assistant

Here’s how we’ll update the layout to meet your requirements:

1. **Margins**:
   - Top and Bottom: `0.5in`
   - Left and Right: `0.25in`

2. **Label Columns**:
   - 3 columns: The left and right columns are justified to the outside edges, and the center column is centered.
   - No horizontal gaps between the labels.
   - The result should fit 30 labels (3 columns, 10 rows) on an 8.5" x 11" page.

3. **Roaring Rita** (formerly Boring Rita) stays as is.
4. **Giggle Water** now uses a cucumber emoji.

### Updated Component:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Expiration Days Input (Hidden during print) -->
    <label for="expirationDays" class="block mb-2 text-lg no-print">Days Until Expiration</label>
    <input
      v-model="expirationDays"
      id="expirationDays"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter days until expiration"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 mx-auto"
    >
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center justify-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDays = ref(10); // Default expiration days

const calculateExpirationDate = (days) => {
  const expirationDate = new Date();
  expirationDate.setDate(today.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Roaring Rita", // Formerly Boring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value), // Dynamically calculated expiration date
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥒", // Cucumber
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
]);

// Default number of labels (30 for each cocktail)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

// Print function to trigger print layout
const printLabels = () => {
  labels.value.forEach((label) => {
    label.expirationDate = calculateExpirationDate(expirationDays.value); // Update expiration date before printing
  });
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **Margins**: The page now has `0.5in` margins on the top and bottom, and `0.25in` on the left and right.
2. **Columns Layout**: The labels are aligned with `justify-content: space-between` to ensure the left and right columns are aligned to the edges, with the center column properly centered.
3. **No Horizontal Gap**: There is no horizontal gap between labels.
4. **Updated Emojis**: 
   - **Roaring Rita** uses the watermelon emoji.
   - **Giggle Water** now uses the cucumber emoji.

This setup should now match your specifications for the label layout and ensure that 30 labels fit correctly on an 8.5" x 11" page. Let me know how it works!

---

## User

Great the variable for expiration date is not working though

---

## Assistant

I see the issue! The problem is that we need to make sure that the expiration date is updated correctly every time the user changes the `expirationDays` input value. Right now, it only updates when you trigger the print, so let's fix it by dynamically updating the expiration date when `expirationDays` changes.

Here’s the updated version that will dynamically recalculate the expiration date as soon as you adjust the number of days in the input.

### Fixed Expiration Date Calculation:

```vue
<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print">Number of Labels Per Cocktail</label>
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Expiration Days Input (Hidden during print) -->
    <label for="expirationDays" class="block mb-2 text-lg no-print">Days Until Expiration</label>
    <input
      v-model="expirationDays"
      id="expirationDays"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter days until expiration"
      @input="updateExpirationDates" <!-- Call this function to update expiration dates -->
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div
      id="labelSheet"
      class="grid grid-cols-3 mx-auto"
    >
      <div
        v-for="label in labels"
        :key="label.id"
        class="label border-4 p-1 rounded-md flex items-center justify-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDays = ref(10); // Default expiration days

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date();
  expirationDate.setDate(today.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update expiration dates across all labels
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Roaring Rita", // Formerly Boring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value), // Dynamically calculated expiration date
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥒", // Cucumber
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
]);

// Default number of labels (30 for each cocktail)
const labelCount = ref(30);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **Dynamic Expiration Date Update**: Now the expiration date will update in real-time when you adjust the expiration days input.
2. **`updateExpirationDates` Function**: This function recalculates the expiration date for all labels whenever the `expirationDays` value changes.

### How It Works:
1. The expiration date will update live as you change the value in the input field.
2. When you print the labels, the expiration date is recalculated based on the latest input value.

This should now resolve the issue of the expiration date not updating dynamically. Let me know how it works!

---

## User

batchDate: formattedToday,

Change this to 8/30 for flapper fire. Just give me the json object

---

## Assistant

Here’s the JSON object with the `batchDate` set to `8/30` specifically for **Flapper Fire**:

```json
[
  {
    "id": 1,
    "cocktail": "Roaring Rita",
    "symbol": "🍉",
    "color": "#FF69B4",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 2,
    "cocktail": "Razz Me Up",
    "symbol": "🍇",
    "color": "#800080",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 3,
    "cocktail": "The Password",
    "symbol": "🔑",
    "color": "#8A2BE2",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 4,
    "cocktail": "Giggle Water",
    "symbol": "🥒",
    "color": "#008000",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 5,
    "cocktail": "Old Sport",
    "symbol": "🎩",
    "color": "#FFA500",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 6,
    "cocktail": "Right In The Kisser",
    "symbol": "👄",
    "color": "#FF0000",
    "batchDate": "9/6/2024",
    "expirationDate": "9/16/2024"
  },
  {
    "id": 7,
    "cocktail": "Flapper Fire",
    "symbol": "🔥",
    "color": "#FFD700",
    "batchDate": "8/30/2024",
    "expirationDate": "9/9/2024"
  }
]
```

### Changes:
- **Flapper Fire** (`id: 7`) has the `batchDate` set to **8/30/2024** while all other labels retain today's date (`9/6/2024`).

Let me know if this works for you!

---

## User

<template>
  <div>
    <!-- Label Count Input (Hidden during print) -->
    <label for="labelCount" class="block mb-2 text-lg no-print"
      >Number of Labels Per Cocktail</label
    >
    <input
      v-model="labelCount"
      id="labelCount"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter number of labels"
    />

    <!-- Expiration Days Input (Hidden during print) -->
    <label for="expirationDays" class="block mb-2 text-lg no-print"
      >Days Until Expiration</label
    >
    <input
      v-model="expirationDays"
      id="expirationDays"
      type="number"
      class="mb-6 border-2 p-2 no-print"
      placeholder="Enter days until expiration"
    />

    <!-- Print Button (Hidden during print) -->
    <button
      @click="printLabels"
      class="mb-6 bg-blue-500 text-white py-2 px-4 rounded no-print"
    >
      Print Labels
    </button>

    <!-- Labels -->
    <div id="labelSheet" class="grid grid-cols-3 mx-auto">
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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

Let's clean up the inputs here so the design is cleaner of the controls. We'll add a title for the label generator. We will put all the controls in to a section with proper styling and then have a horizontal line to break up the section with the controls and the section with the labels. 

---

## Assistant

Here's an updated version of your component with a cleaner design for the input controls, proper styling, and a horizontal line separating the controls from the labels. I've added a title for the label generator, styled the control section, and organized everything more clearly.

### Updated Component:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl font-bold mb-4 text-center">Label Generator</h1>

    <!-- Control Section -->
    <div class="bg-gray-100 p-4 rounded-md shadow-md">
      <!-- Number of Labels Input -->
      <div class="mb-4">
        <label for="labelCount" class="block mb-2 text-lg font-semibold">Number of Labels Per Cocktail</label>
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="mb-4">
        <label for="expirationDays" class="block mb-2 text-lg font-semibold">Days Until Expiration</label>
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Print Button -->
      <div class="text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 gap-4 mx-auto">
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref } from "vue";

definePageMeta({
  layout: "minimal",
});

const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDays = ref(10); // Default expiration days

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date();
  expirationDate.setDate(today.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update expiration dates across all labels
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Array for cocktails and labels with appropriate symbols and updated colors
const labels = ref([
  {
    id: 1,
    cocktail: "Roaring Rita", // Formerly Boring Rita
    symbol: "🍉", // Watermelon
    color: "#FF69B4", // Pink
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value), // Dynamically calculated expiration date
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇", // Raspberry
    color: "#800080", // Purple
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑", // Key
    color: "#8A2BE2",
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥒", // Cucumber
    color: "#008000", // Green
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩", // Top Hat
    color: "#FFA500", // Orange
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄", // Lips
    color: "#FF0000", // Red
    batchDate: formattedToday,
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥", // Fire
    color: "#FFD700", // Yellow
    batchDate: "8/30/2024", // Fixed batch date for Flapper Fire
    expirationDate: calculateExpirationDate(expirationDays.value),
  },
]);

// Default number of labels (30 for each cocktail)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Changes:
1. **Title Section**: Added a title "Label Generator" to the top for clarity.
2. **Control Section**: Wrapped the input fields and the print button inside a styled container with rounded corners and shadow for a clean look.
3. **Horizontal Line**: Added a horizontal line (`<hr>`) to separate the control section from the labels.
4. **Centered Labels**: The labels are laid out as before, but now the control section looks cleaner and more polished.

This layout should now be much cleaner, with a clear division between the controls and the generated labels. Let me know if you'd like any further adjustments!

---

## User

Let's add some features here.

Firs ta check box to select today as the date or to pick a date. 
Second lets extract the json object to its own file. Currently the file is in tools/Label-Generator.vue, we'll move it to a folder for the label generator with the component now being the index.vue in there and the json file being in there as well

---

## Assistant

To implement these updates, we will:

1. **Add a Checkbox** to either select today as the date or allow the user to pick a custom date.
2. **Move the JSON data** to a separate file.
3. **Reorganize the component structure** so the main component becomes `index.vue`, and we move the JSON file to the same folder.

### Steps:

1. **Add the checkbox for selecting today's date or choosing a custom date.**
2. **Move the JSON object to a separate file** in the same folder as the `index.vue`.

### File Structure:

```
/tools/label-generator/
  ├── index.vue
  ├── labelData.js
```

### Step 1: Update the Component (`index.vue`)

Here’s the updated `index.vue` file with the new checkbox feature:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl font-bold mb-4 text-center">Label Generator</h1>

    <!-- Control Section -->
    <div class="bg-gray-100 p-4 rounded-md shadow-md">
      <!-- Number of Labels Input -->
      <div class="mb-4">
        <label for="labelCount" class="block mb-2 text-lg font-semibold">Number of Labels Per Cocktail</label>
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="mb-4">
        <label for="expirationDays" class="block mb-2 text-lg font-semibold">Days Until Expiration</label>
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="mb-4">
        <input type="checkbox" id="useToday" v-model="useToday" class="mr-2">
        <label for="useToday" class="text-lg font-semibold">Use today's date</label>
      </div>

      <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
      <div v-if="!useToday" class="mb-4">
        <label for="customDate" class="block mb-2 text-lg font-semibold">Select Custom Batch Date</label>
        <input
          v-model="customDate"
          id="customDate"
          type="date"
          class="w-full border-2 p-2 rounded-md"
        />
      </div>

      <!-- Print Button -->
      <div class="text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 gap-4 mx-auto">
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref } from "vue";
import { labelsData } from './labelData.js'; // Importing the JSON data from a separate file

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days

// Selects the batch date based on checkbox
const batchDate = () => useToday.value ? today : customDate.value;

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate());
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Update expiration dates across all labels
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate(); // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

const labels = ref(labelsData); // Use the external JSON data for labels

// Default number of labels (30 for each cocktail)
const labelCount = ref(30);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Step 2: Create the JSON File (`labelData.js`)

In the same folder as `index.vue`, create the `labelData.js` file to store the cocktail label data:

```javascript
export const labelsData = [
  {
    id: 1,
    cocktail: "Roaring Rita",
    symbol: "🍉",
    color: "#FF69B4",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇",
    color: "#800080",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑",
    color: "#8A2BE2",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥒",
    color: "#008000",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩",
    color: "#FFA500",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄",
    color: "#FF0000",
    batchDate: "9/6/2024",
    expirationDate: "9/16/2024"
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥",
    color: "#FFD700",
    batchDate: "8/30/2024",
    expirationDate: "9/9/2024"
  }
];
```

### Explanation of Changes:
1. **Checkbox**: A checkbox allows users to choose whether to use today's date or a custom date. When unchecked, a date picker appears to select a custom batch date

---

## Assistant

To implement the features you're asking for, we will:

1. **Add a checkbox** to either select today's date or allow the user to pick a custom date.
2. **Extract the JSON object** for the cocktails and move it into a separate file for better structure.
3. **Move the component to `index.vue`** and create a separate JSON file for the cocktail data in the `label-generator` folder.

### Steps:

1. **Move the component** `Label-Generator.vue` to `label-generator/index.vue`.
2. **Create a new file** for the JSON object `cocktailData.js` inside the `label-generator` folder.

### Here's how we'll structure this:

#### File Structure:
```
/label-generator/
  ├── index.vue
  ├── cocktailData.js
```

#### **Step 1**: `cocktailData.js` (the JSON file for the cocktail labels)
```javascript
export const cocktailLabels = [
  {
    id: 1,
    cocktail: "Roaring Rita",
    symbol: "🍉",
    color: "#FF69B4",
    batchDate: new Date().toLocaleDateString(), // Default to today's date
    expirationDate: "", // Expiration date will be calculated later
  },
  {
    id: 2,
    cocktail: "Razz Me Up",
    symbol: "🍇",
    color: "#800080",
    batchDate: new Date().toLocaleDateString(),
    expirationDate: "",
  },
  {
    id: 3,
    cocktail: "The Password",
    symbol: "🔑",
    color: "#8A2BE2",
    batchDate: new Date().toLocaleDateString(),
    expirationDate: "",
  },
  {
    id: 4,
    cocktail: "Giggle Water",
    symbol: "🥒",
    color: "#008000",
    batchDate: new Date().toLocaleDateString(),
    expirationDate: "",
  },
  {
    id: 5,
    cocktail: "Old Sport",
    symbol: "🎩",
    color: "#FFA500",
    batchDate: new Date().toLocaleDateString(),
    expirationDate: "",
  },
  {
    id: 6,
    cocktail: "Right In The Kisser",
    symbol: "👄",
    color: "#FF0000",
    batchDate: new Date().toLocaleDateString(),
    expirationDate: "",
  },
  {
    id: 7,
    cocktail: "Flapper Fire",
    symbol: "🔥",
    color: "#FFD700",
    batchDate: "8/30/2024", // Fixed batch date for Flapper Fire
    expirationDate: "",
  },
];
```

#### **Step 2**: `index.vue` (Main Label Generator component)
Here we are adding:
- A **checkbox** to toggle between today's date or custom date.
- Logic to pull the JSON object from the external file (`cocktailData.js`).

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl font-bold mb-4 text-center">Label Generator</h1>

    <!-- Control Section -->
    <div class="bg-gray-100 p-4 rounded-md shadow-md">
      <!-- Number of Labels Input -->
      <div class="mb-4">
        <label for="labelCount" class="block mb-2 text-lg font-semibold">Number of Labels Per Cocktail</label>
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="mb-4">
        <label for="expirationDays" class="block mb-2 text-lg font-semibold">Days Until Expiration</label>
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Batch Date Input -->
      <div class="mb-4">
        <label class="block mb-2 text-lg font-semibold">Batch Date</label>
        <input
          type="checkbox"
          v-model="useTodayDate"
          class="mr-2"
        />
        <label>Use today's date</label>

        <!-- Show date picker only if not using today's date -->
        <div v-if="!useTodayDate" class="mt-2">
          <input
            v-model="customBatchDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 gap-4 mx-auto">
      <div
        v-for="label in generateLabels()"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref } from "vue";
import { cocktailLabels } from "./cocktailData"; // Import the cocktail labels JSON

definePageMeta({
  layout: "minimal",
});

// Default values
const today = new Date();
const formattedToday = today.toLocaleDateString();
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels

// State for toggling between today's date and custom date
const useTodayDate = ref(true);
const customBatchDate = ref(formattedToday); // Default to today's date

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date();
  expirationDate.setDate(today.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update expiration dates across all labels
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Set the batch date either to today's date or custom
const getBatchDate = () => {
  return useTodayDate.value ? formattedToday : new Date(customBatchDate.value).toLocaleDateString();
};

// Load the cocktail data and set the batch date based on the user's selection
const labels = ref(
  cocktailLabels.map((label) => ({
    ...label,
    batchDate: getBatchDate(),
    expirationDate: calculateExpirationDate(expirationDays.value),
  }))
);

// Function to generate repeated labels for each cocktail
const generateLabels = () => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
};

// Print function to trigger print layout
const printLabels = () => {
  labels.value.forEach((label) => {
    label.batchDate = getBatchDate(); // Ensure the batch date is updated before printing
    label.expirationDate = calculateExpirationDate(expirationDays.value); // Ensure expiration date is updated before printing
  });
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
 

---

## User

K great now we need the page to refresh when you change the date or numbers. It does update if I change the number of labels but not if I change the date. So we need those updates to happen

---

## Assistant

To ensure the page refreshes and updates dynamically when you change the date or the number of labels, we need to make sure that whenever you update the batch date or expiration days, the labels are recalculated and rendered correctly. The issue occurs because the `generateLabels()` function isn't being triggered when changing the custom date or the expiration days.

### Solution:
1. **Use Watchers**: We can add watchers in Vue to track changes in `useToday`, `customDate`, and `expirationDays` and trigger `generateLabels()` every time one of them changes.
2. **Trigger Label Updates Dynamically**: We'll trigger the `generateLabels()` function to refresh the labels dynamically whenever the user updates these values.

### Updated Component with Watchers:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl font-bold mb-4 text-center">Label Generator</h1>

    <!-- Control Section -->
    <div class="bg-gray-100 p-4 rounded-md shadow-md">
      <!-- Number of Labels Input -->
      <div class="mb-4">
        <label for="labelCount" class="block mb-2 text-lg font-semibold">Number of Labels Per Cocktail</label>
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="mb-4">
        <label for="expirationDays" class="block mb-2 text-lg font-semibold">Days Until Expiration</label>
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="w-full border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="mb-4">
        <input type="checkbox" id="useToday" v-model="useToday" class="mr-2">
        <label for="useToday" class="text-lg font-semibold">Use today's date</label>
      </div>

      <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
      <div v-if="!useToday" class="mb-4">
        <label for="customDate" class="block mb-2 text-lg font-semibold">Select Custom Batch Date</label>
        <input
          v-model="customDate"
          id="customDate"
          type="date"
          class="w-full border-2 p-2 rounded-md"
        />
      </div>

      <!-- Print Button -->
      <div class="text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 gap-4 mx-auto">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref, watch, computed } from "vue";
import { labelsData } from './labelData.js'; // Importing the JSON data from a separate file

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => useToday.value ? today : customDate.value);

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch([useToday, customDate, expirationDays, labelCount], updateExpirationDates);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **Watchers**: Added `watch()` on `useToday`, `customDate`, `expirationDays`, and `labelCount` to trigger the `updateExpirationDates` function whenever any of these values change. This ensures that the page will update dynamically as soon as the user changes the date or number of labels.
2. **`batchDate` is now a `computed` property**: It will dynamically calculate the correct batch date based on the checkbox (today's date or custom date).
3. **`generatedLabels` is also a `computed` property**: It ensures that the labels are always updated based on the latest values for `labelCount`, `useToday`, `customDate`, and `expirationDays`.

### Expected Behavior:
- When you change the number of labels, expiration days, or the batch date (via checkbox or date picker), the labels will automatically refresh and display the correct values.
- The page should now update instantly without needing to manually trigger anything.

Let me know if this resolves the issue!

---

## User

Make sure we still use the minimal  template from vue and also amex sure the whole tools sections is hidden from print view. All of our styling for the print view and labels was correct before we split this into a folder and multiple files
Also  we could clean up the tools sections so its doesnt occupy so much space. Maybe use more styling o put the controls in a concise layout


---

## Assistant

To ensure that we're using the **minimal layout** from Vue and that the tool section is hidden during the print view, while also cleaning up the controls section for a more concise and clean look, here’s how we can update the component:

### Steps:
1. **Ensure minimal layout**: We’ll ensure that the minimal template is being used.
2. **Hide the control section in print view**: The tool section will be hidden during printing.
3. **Clean up the control section layout**: We’ll condense the input controls for a cleaner and more compact layout using flexbox and grid.
4. **Preserve the correct label and print styles**: We'll make sure that print view has the same clean styles as before.

### Updated Component:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl font-bold mb-4 text-center">Label Generator</h1>

    <!-- Control Section (Hidden in print view) -->
    <div class="bg-gray-100 p-4 rounded-md shadow-md no-print flex flex-wrap items-center justify-between space-y-4">
      <!-- Number of Labels Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="labelCount" class="mb-2 text-lg font-semibold">Number of Labels</label>
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="expirationDays" class="mb-2 text-lg font-semibold">Days Until Expiration</label>
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="w-full md:w-1/3 flex flex-col items-start">
        <label class="mb-2 text-lg font-semibold">Batch Date</label>
        <div class="flex items-center space-x-2">
          <input type="checkbox" id="useToday" v-model="useToday" class="mr-2">
          <label for="useToday">Use today's date</label>
        </div>
        <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
        <div v-if="!useToday" class="mt-2 w-full">
          <input
            v-model="customDate"
            id="customDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="w-full text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300 no-print" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 gap-4 mx-auto">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref, watch, computed } from "vue";
import { labelsData } from './labelData.js'; // Importing the JSON data from a separate file

definePageMeta({
  layout: "minimal", // Ensure we use the minimal layout
});

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => useToday.value ? today : customDate.value);

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch([useToday, customDate, expirationDays, labelCount], updateExpirationDates);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */
    padding: 0.5in 0.25in; /* 0.5in top/bottom, 0.25in left/right margins */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>
```

### Key Changes:
1. **Minimal Layout**: Ensures that the minimal layout is applied by adding `layout: "minimal"` in the `definePageMeta`.
2. **Cleaner Control Section**:
   - The controls are now more compact using `flexbox` for alignment and wrapping.
   - The entire control section is hidden during the print view (`.no-print` class).
3. **Responsive Input Fields**:
   - Each input is contained in its own `div` with a width defined (`w-full` for smaller screens and `md:w-1/3` for medium screens) to make the layout more concise.
4. **Retained Print Styles**: Ensured the print layout is preserved as before, with the correct label dimensions, no gaps, and proper margins.

### Expected Result:
- The control section is now more compact and will be hidden during printing.
- The print view will look as before, with the correct label layout.
- The minimal layout is applied for the overall page structure.

Let me know if this resolves everything!

---

## User

<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl no-print font-bold mb-4 text-center">
      Label Generator
    </h1>

    <!-- Control Section (Hidden in print view) -->
    <div
      class="bg-gray-100 p-4 rounded-md shadow-md no-print flex flex-wrap items-center justify-between space-y-4"
    >
      <!-- Number of Labels Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="labelCount" class="mb-2 text-lg font-semibold"
          >Number of Labels</label
        >
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="expirationDays" class="mb-2 text-lg font-semibold"
          >Days Until Expiration</label
        >
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="w-full md:w-1/3 flex flex-col items-start">
        <label class="mb-2 text-lg font-semibold">Batch Date</label>
        <div class="flex items-center space-x-2">
          <input
            type="checkbox"
            id="useToday"
            v-model="useToday"
            class="mr-2"
          />
          <label for="useToday">Use today's date</label>
        </div>
        <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
        <div v-if="!useToday" class="mt-2 w-full">
          <input
            v-model="customDate"
            id="customDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="w-full text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300 no-print" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 justify-between mx-auto">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref, watch, computed } from "vue";
import { labelsData } from "./labelData.js"; // Importing the JSON data from a separate file

definePageMeta({
  layout: "minimal", // Ensure we use the minimal layout
});

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => (useToday.value ? today : customDate.value));

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch(
  [useToday, customDate, expirationDays, labelCount],
  updateExpirationDates
);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    grid-template-columns: 2.625in 2.625in 2.625in; /* 3 labels per row with no gap */

    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
    gap-x: 0; /* No horizontal gap between labels */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}

.label {
  text-align: left;
}
</style>


This is great only problem is the label sheet should have the 3 columns of labels justified between the full width and display a full 10 rows per sheet for 30 labels per page. There should be no left or right margin or top or bottom margin in th sprint view

---

## Assistant

Thank you for the clarification. To achieve the desired layout where the labels are distributed evenly in 3 columns, with 10 rows per page (30 labels per page) and no left, right, top, or bottom margins, we need to adjust the CSS for the print view.

Here’s how to modify the CSS to ensure the labels fill the entire page, with no gaps or margins, and that the labels are perfectly aligned in 3 columns and 10 rows:

### Updated Code:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl no-print font-bold mb-4 text-center">
      Label Generator
    </h1>

    <!-- Control Section (Hidden in print view) -->
    <div
      class="bg-gray-100 p-4 rounded-md shadow-md no-print flex flex-wrap items-center justify-between space-y-4"
    >
      <!-- Number of Labels Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="labelCount" class="mb-2 text-lg font-semibold"
          >Number of Labels</label
        >
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="expirationDays" class="mb-2 text-lg font-semibold"
          >Days Until Expiration</label
        >
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="w-full md:w-1/3 flex flex-col items-start">
        <label class="mb-2 text-lg font-semibold">Batch Date</label>
        <div class="flex items-center space-x-2">
          <input
            type="checkbox"
            id="useToday"
            v-model="useToday"
            class="mr-2"
          />
          <label for="useToday">Use today's date</label>
        </div>
        <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
        <div v-if="!useToday" class="mt-2 w-full">
          <input
            v-model="customDate"
            id="customDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="w-full text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300 no-print" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 justify-between mx-auto">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref, watch, computed } from "vue";
import { labelsData } from "./labelData.js"; // Importing the JSON data from a separate file

definePageMeta({
  layout: "minimal", // Ensure we use the minimal layout
});

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => (useToday.value ? today : customDate.value));

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch(
  [useToday, customDate, expirationDays, labelCount],
  updateExpirationDates
);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    /* 3 labels per row with no gap */
    display: grid;
    grid-template-columns: 1fr 1fr 1fr; 
    width: 100%; /* Full width */
    height: 100%; /* Full height for the page */
    padding: 0;
    margin: 0;
    gap: 0; /* No gaps between the labels */
    justify-content: space-between; /* Ensure the left and right labels are aligned to the outside */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}
</style>
```

### Key Changes:
1. **No Margins or Padding in Print View**: In the print view, there are no margins (`padding: 0; margin: 0;`), which allows the labels to use the entire page.
2. **Full Page Utilization**: The grid is set to have three equal-width columns (`grid-template-columns: 1fr 1fr 1fr`) that take up the full width of the page.
3. **10 Rows Per Page**: The grid layout automatically ensures that there will be 10 rows, as the label heights are fixed to `1in`, and the page height is assumed to be `11in`.

### Expected Behavior:
- The labels will perfectly align into 3 columns and 10 rows (30 labels per page), utilizing the full width and height of the page with no gaps or margins.

Let me know if this meets your expectations!

---

## User

I will have the printer dialog box automatically add .5in margin top and bottom and .25in left and right. So the print view we send to print dialogue should have no margin or we'd end up with extra margin.  I want the 1st and 3rd column to touch the left and right edges with the the middle column centered. This means we'll have even spacing between columns and no spacing between rows.

The image attached Is the current print preview with the auto margin being added by the print dialog. You will see in the shot that the layout is not perfect yet.

---

## Assistant

Got it! To achieve your desired layout, where:

1. **No margins or padding** are added in the print view (since the printer will automatically add margins).
2. The **1st and 3rd columns** touch the left and right edges, and the **middle column is centered**.
3. **Even spacing** between the columns with no vertical spacing between rows.

We need to update the CSS for the print view accordingly, and we will ensure that the layout fills the page without adding any extra margins or gaps.

### Updated Code:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl no-print font-bold mb-4 text-center">
      Label Generator
    </h1>

    <!-- Control Section (Hidden in print view) -->
    <div
      class="bg-gray-100 p-4 rounded-md shadow-md no-print flex flex-wrap items-center justify-between space-y-4"
    >
      <!-- Number of Labels Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="labelCount" class="mb-2 text-lg font-semibold"
          >Number of Labels</label
        >
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="expirationDays" class="mb-2 text-lg font-semibold"
          >Days Until Expiration</label
        >
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="w-full md:w-1/3 flex flex-col items-start">
        <label class="mb-2 text-lg font-semibold">Batch Date</label>
        <div class="flex items-center space-x-2">
          <input
            type="checkbox"
            id="useToday"
            v-model="useToday"
            class="mr-2"
          />
          <label for="useToday">Use today's date</label>
        </div>
        <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
        <div v-if="!useToday" class="mt-2 w-full">
          <input
            v-model="customDate"
            id="customDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="w-full text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300 no-print" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 justify-between mx-auto">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center"
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
import { ref, watch, computed } from "vue";
import { labelsData } from "./labelData.js"; // Importing the JSON data from a separate file

definePageMeta({
  layout: "minimal", // Ensure we use the minimal layout
});

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => (useToday.value ? today : customDate.value));

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch(
  [useToday, customDate, expirationDays, labelCount],
  updateExpirationDates
);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
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
    /* Full width with no margin or padding */
    display: grid;
    grid-template-columns: 2.625in 2.625in 2.625in; /* Three equal columns for labels */
    gap: 0; /* No gaps between rows or columns */
    width: 100vw; /* Full width of the viewport */
    height: 100vh; /* Full height of the viewport */
    justify-content: space-between; /* Ensures the 1st and 3rd columns touch the edges */
    padding: 0;
    margin: 0;
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}
</style>
```

### Key Adjustments:
1. **No Margins or Padding in Print View**: Removed all padding and margins in the print view (`padding: 0; margin: 0;`) to ensure that the labels fill the entire page without extra space.
2. **Touching Edges**: The `#labelSheet` grid now has `justify-content: space-between;` to ensure the first and third columns touch the edges, and the middle column is centered.
3. **No Gaps Between Labels**: I set `gap: 0;` so there is no spacing between the rows or columns of labels.

### Expected Result:
- When printed, the first and third columns will touch the left and right edges of the page.
- The middle column will be centered.
- No extra margins or gaps will appear between rows and columns.
- The print dialog's automatic margins will correctly apply, and no additional margins will be added by the layout.

Let me know if this resolves the layout issue as expected!

---

## User

{'asset_pointer': 'file-service://file-l9ZMEX2RE9BPrExgkgdeTvG9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 746, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 753457, 'width': 1253}

---

## Assistant

Based on the screenshot, I see that the layout is still not perfectly aligned, especially with regards to the 1st and 3rd columns needing to touch the edges, and the middle column being centered.

Here's what we need to fix:

1. **Ensure that the 1st and 3rd columns touch the left and right edges**.
2. **Center the middle column properly**.
3. **Remove the extra gap between rows**.

I will adjust the grid layout CSS again to ensure that all columns are perfectly aligned and the entire page is utilized correctly.

### Updated CSS:

```css
@media print {
  .no-print {
    display: none;
  }

  body {
    margin: 0;
  }

  #labelSheet {
    /* Adjust the grid to have 3 columns touching edges */
    display: grid;
    grid-template-columns: 1fr 1fr 1fr; /* Equal-width columns */
    width: 100vw; /* Full width of the viewport */
    height: 100vh; /* Full height of the viewport */
    justify-content: space-between; /* Ensures 1st and 3rd columns touch the left and right edges */
    align-content: stretch; /* Make rows fill the entire height */
    padding: 0;
    margin: 0;
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
  }
}
```

### Key Adjustments:

- **No Gap Between Rows or Columns**: We are using `justify-content: space-between` to ensure that the 1st and 3rd columns touch the left and right edges.
- **`align-content: stretch`**: This makes sure the rows fill the entire height of the page and no gaps appear between them.
- **No Padding or Margins**: There are no margins or padding, so the labels will fully use the space within the page without any extra spacing.

With this update, the print layout should correctly align the labels, and the columns should now be perfectly centered without any extra gaps.

Let me know if this resolves the issue!

---

## User

{'asset_pointer': 'file-service://file-EuZOkv2XbTQYCEhR440T5hRo', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 872, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 849896, 'width': 1420}

---

## Assistant

Based on the latest screenshot, it seems the columns are still not aligned perfectly to the edges, and the layout needs further refinement to achieve the exact desired alignment.

### Next Steps:
1. **Force the 1st and 3rd columns to touch the edges** by adjusting the column layout and ensuring that the space between the columns is uniform.
2. **Ensure there's no vertical spacing between rows** and that the entire page is used efficiently.

I will make adjustments to the CSS to ensure the labels are aligned as expected.

### Updated CSS:

```css
@media print {
  .no-print {
    display: none;
  }

  body {
    margin: 0;
  }

  #labelSheet {
    /* Full width with no margin or padding */
    display: grid;
    grid-template-columns: 2.625in 2.625in 2.625in; /* Three fixed columns for labels */
    grid-template-rows: repeat(10, 1in); /* 10 rows per page */
    justify-content: space-between; /* Ensures 1st and 3rd columns touch the left and right edges */
    padding: 0;
    margin: 0;
    width: 100vw; /* Full width */
    height: 100vh; /* Full height */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
    margin: 0;
    padding: 0;
  }
}
```

### Explanation:
- **grid-template-columns**: Set to `2.625in 2.625in 2.625in` to create three fixed-width columns for the labels.
- **grid-template-rows**: I set it to `repeat(10, 1in)` to ensure there are exactly 10 rows per page (since each label is 1 inch in height).
- **justify-content: space-between**: Ensures that the 1st and 3rd columns touch the left and right edges of the page.
- **No padding or margins**: Removed any margins or padding that could cause misalignment.
  
This should now align the labels properly, making full use of the page width and height, with 3 columns and 10 rows of labels per page.

Try this update and let me know if it achieves the desired result!

---

## User

{'asset_pointer': 'file-service://file-d9LM7R4jZr9ZKvvxRWD9gvej', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 888, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 893230, 'width': 1470}

---

## Assistant

From the screenshot, it looks like we're very close, but the alignment still needs some tweaking to ensure the labels fully utilize the available space and align perfectly without extra gaps on the left, right, top, and bottom.

To address this:

### Updated CSS:
1. We'll ensure that the `grid-template-columns` are exactly what we need for the labels to span across the page, touching the edges.
2. We'll also refine the row spacing so that there is no extra vertical gap between the rows.

### Adjusted CSS:

```css
@media print {
  .no-print {
    display: none;
  }

  body {
    margin: 0;
  }

  #labelSheet {
    /* Full width with no margin or padding */
    display: grid;
    grid-template-columns: 2.625in 2.625in 2.625in; /* Three fixed columns for labels */
    grid-template-rows: repeat(10, 1in); /* 10 rows per page */
    justify-content: space-between; /* Ensures 1st and 3rd columns touch the left and right edges */
    padding: 0;
    margin: 0;
    box-sizing: border-box;
    width: 100vw; /* Full width of the viewport */
    height: 100vh; /* Full height of the viewport */
  }

  .label {
    width: 2.625in; /* 2 5/8 inches wide */
    height: 1in; /* 1 inch tall */
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
}
```

### Key Adjustments:
- **grid-template-columns and grid-template-rows**: This keeps the labels locked into 3 columns and 10 rows of exactly the right size.
- **box-sizing: border-box**: This ensures that padding and borders are included within the element’s width and height, which helps eliminate extra spacing issues.

With these adjustments, the columns should now touch the left and right edges, and the vertical spacing should be gone.

Please try this updated CSS and let me know if it achieves the result you're aiming for!

---

## User

Use only tailwind css

---

## Assistant

Got it! I'll convert the custom CSS into pure **Tailwind CSS** classes to achieve the same effect, ensuring the labels are aligned correctly without needing custom CSS.

### Tailwind CSS-only Implementation:

```vue
<template>
  <div class="container mx-auto p-6">
    <!-- Title for Label Generator -->
    <h1 class="text-2xl no-print font-bold mb-4 text-center">
      Label Generator
    </h1>

    <!-- Control Section (Hidden in print view) -->
    <div
      class="bg-gray-100 p-4 rounded-md shadow-md no-print flex flex-wrap items-center justify-between space-y-4"
    >
      <!-- Number of Labels Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="labelCount" class="mb-2 text-lg font-semibold"
          >Number of Labels</label
        >
        <input
          v-model="labelCount"
          id="labelCount"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter number of labels"
        />
      </div>

      <!-- Expiration Days Input -->
      <div class="w-full md:w-1/3 flex flex-col">
        <label for="expirationDays" class="mb-2 text-lg font-semibold"
          >Days Until Expiration</label
        >
        <input
          v-model="expirationDays"
          id="expirationDays"
          type="number"
          class="border-2 p-2 rounded-md"
          placeholder="Enter days until expiration"
        />
      </div>

      <!-- Checkbox for using today's date or a custom date -->
      <div class="w-full md:w-1/3 flex flex-col items-start">
        <label class="mb-2 text-lg font-semibold">Batch Date</label>
        <div class="flex items-center space-x-2">
          <input
            type="checkbox"
            id="useToday"
            v-model="useToday"
            class="mr-2"
          />
          <label for="useToday">Use today's date</label>
        </div>
        <!-- Date picker for custom date (hidden when 'Use today's date' is checked) -->
        <div v-if="!useToday" class="mt-2 w-full">
          <input
            v-model="customDate"
            id="customDate"
            type="date"
            class="w-full border-2 p-2 rounded-md"
          />
        </div>
      </div>

      <!-- Print Button -->
      <div class="w-full text-center">
        <button
          @click="printLabels"
          class="bg-blue-500 text-white py-2 px-6 rounded-md hover:bg-blue-600"
        >
          Print Labels
        </button>
      </div>
    </div>

    <!-- Horizontal Line -->
    <hr class="my-6 border-gray-300 no-print" />

    <!-- Labels Section -->
    <div id="labelSheet" class="grid grid-cols-3 mx-auto w-full h-screen print:grid-cols-3 print:w-screen print:h-screen print:gap-0 print:m-0 print:p-0">
      <div
        v-for="label in generatedLabels"
        :key="label.id"
        class="label border-8 p-1 rounded-md flex items-center justify-center print:w-[2.625in] print:h-[1in]"
        :style="{ borderColor: label.color }"
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
import { ref, watch, computed } from "vue";
import { labelsData } from "./labelData.js"; // Importing the JSON data from a separate file

definePageMeta({
  layout: "minimal", // Ensure we use the minimal layout
});

const today = new Date().toISOString().slice(0, 10); // Get today's date in YYYY-MM-DD format
const customDate = ref(today); // Default to today's date for the date picker
const useToday = ref(true); // Checkbox for using today's date
const expirationDays = ref(10); // Default expiration days
const labelCount = ref(30); // Default number of labels
const labels = ref(labelsData); // Use the external JSON data for labels

// Selects the batch date based on checkbox
const batchDate = computed(() => (useToday.value ? today : customDate.value));

// Function to calculate expiration date dynamically based on the input
const calculateExpirationDate = (days) => {
  const expirationDate = new Date(batchDate.value);
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toLocaleDateString();
};

// Function to update the batch and expiration dates for each label
const updateExpirationDates = () => {
  labels.value.forEach((label) => {
    label.batchDate = batchDate.value; // Use today's date or custom date
    label.expirationDate = calculateExpirationDate(expirationDays.value);
  });
};

// Computed function to generate repeated labels for each cocktail
const generatedLabels = computed(() => {
  let allLabels = [];
  labels.value.forEach((label) => {
    for (let i = 0; i < labelCount.value; i++) {
      allLabels.push({ ...label, id: `${label.id}-${i}` });
    }
  });
  return allLabels;
});

// Watch for changes in the date or number of labels and update the labels
watch(
  [useToday, customDate, expirationDays, labelCount],
  updateExpirationDates
);

// Print function to trigger print layout
const printLabels = () => {
  updateExpirationDates(); // Ensure the expiration dates are updated before printing
  window.print();
};
</script>

<style>
@media print {
  body {
    margin: 0;
    padding: 0;
  }
}
</style>
```

### Tailwind CSS Adjustments:
1. **Responsive Layout**:
   - `grid grid-cols-3`: Ensures the labels are laid out in 3 columns.
   - `print:w-screen print:h-screen`: Utilizes the full width and height of the screen when printing.
   - `print:gap-0 print:m-0 print:p-0`: Removes any gap, margin, or padding in the print view.
   - `print:w-[2.625in] print:h-[1in]`: Sets the exact width and height for each label to match the label dimensions (2.625 inches wide and 1 inch tall).

### Expected Behavior:
- The labels will be perfectly aligned in 3 columns, touching the left and right edges.
- The print view will take up the full screen with no extra margin, padding, or gaps.
- The first and third columns should touch the edges, with the middle column centered.
  
Let me know if this works as expected!
