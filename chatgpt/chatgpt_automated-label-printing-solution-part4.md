
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
 


K great now we need the page to refresh when you change the date or numbers. It does update if I change the number of labels but not if I change the date. So we need those updates to happen


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


Make sure we still use the minimal  template from vue and also amex sure the whole tools sections is hidden from print view. All of our styling for the print view and labels was correct before we split this into a folder and multiple files
Also  we could clean up the tools sections so its doesnt occupy so much space. Maybe use more styling o put the controls in a concise layout



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


## See Also
- [[chatgpt/chatgpt_automated-label-printing-solution-part1]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part2]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part3]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part5]]
- [[chatgpt/chatgpt_automated-venue-scheduling-solution]]
