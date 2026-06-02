
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


{'asset_pointer': 'file-service://file-kxwR06JVqprDW0LMRockKpjV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 751, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 553418, 'width': 1082}


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


So it seems the template has a slight margin on top and bottom and 0 vertical gap between labels while it has a slight horizontal gap.

Im including the pdf of the template again so you can see 


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


Add flapper fire as a cocktail and make it yellow with a fire emoji


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


Increase the horizontal gap in print view and make sure its horizontally centered, currently the margin on the right is large and on the left it doesnt exist


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


{'asset_pointer': 'file-service://file-Kk6rZCJDzah3ROaXHmxgTGgc', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 627, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 362892, 'width': 693}
The second page and first page have different top margins. The second page has none
