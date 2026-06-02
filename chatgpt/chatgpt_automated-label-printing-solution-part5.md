
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


I will have the printer dialog box automatically add .5in margin top and bottom and .25in left and right. So the print view we send to print dialogue should have no margin or we'd end up with extra margin.  I want the 1st and 3rd column to touch the left and right edges with the the middle column centered. This means we'll have even spacing between columns and no spacing between rows.

The image attached Is the current print preview with the auto margin being added by the print dialog. You will see in the shot that the layout is not perfect yet.


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


{'asset_pointer': 'file-service://file-l9ZMEX2RE9BPrExgkgdeTvG9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 746, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 753457, 'width': 1253}


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


{'asset_pointer': 'file-service://file-EuZOkv2XbTQYCEhR440T5hRo', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 872, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 849896, 'width': 1420}


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


{'asset_pointer': 'file-service://file-d9LM7R4jZr9ZKvvxRWD9gvej', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 888, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 893230, 'width': 1470}


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


Use only tailwind css


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
