
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


My minimal template is set to this:

<template>
  <div class="flex flex-col justify-between h-screen bg-white">
    <slot></slot>
  </div>
</template>

Let me know if this Is effecting the printed view at all and if it should be changed



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


Make the value 10 (for difference between date and expiration) a variable that we set like the number of labels


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


Every page should have a .5in margin top and Botton and a .25in margin left and right. The labels columns should be 3 with the left and right being justified to the outside with no margin or padding and the center one center. no gap between labels horizantally. And that should result in a 8.5/11 page having 30 labels

Also boring rita is the roaring rita.
cucumber emoji for Giggle Water



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


Great the variable for expiration date is not working though


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


batchDate: formattedToday,

Change this to 8/30 for flapper fire. Just give me the json object


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


Let's add some features here.

Firs ta check box to select today as the date or to pick a date. 
Second lets extract the json object to its own file. Currently the file is in tools/Label-Generator.vue, we'll move it to a folder for the label generator with the component now being the index.vue in there and the json file being in there as well
