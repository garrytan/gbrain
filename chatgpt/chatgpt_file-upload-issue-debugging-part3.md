
<template>
    <div>
        <div class="px-4 py-6">
            <div class="sm:flex sm:items-center">
                <div class="sm:flex-auto">
                    <h1 class="text-base font-semibold leading-6 text-gray-900">
                        Body Tracking
                    </h1>
                    <p class="mt-2 text-sm text-gray-700">
                        The table below shows your weight and body composition
                        changes for each day you've logged them.
                    </p>
                </div>
                <div class="mt-4 sm:ml-16 space-y-2 sm:mt-0 sm:flex-none">
                    <button
                        @click="newEntry()"
                        type="button"
                        class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                    >
                        Add Entry
                    </button>
                    <button
                        @click="importForm()"
                        type="button"
                        class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                    >
                        Import
                    </button>
                </div>
            </div>

            <table class="min-w-full divide-y divide-gray-300">
                <thead>
                    <tr>
                        <th
                            scope="col"
                            class="whitespace-nowrap py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0"
                        >
                            Date
                        </th>
                        <th
                            scope="col"
                            class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900"
                        >
                            Weight
                        </th>
                        <th
                            scope="col"
                            class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900"
                        >
                            BF %
                        </th>
                        <th
                            scope="col"
                            class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900"
                        >
                            Method
                        </th>

                        <th
                            scope="col"
                            class="relative whitespace-nowrap py-3.5 pl-3 pr-4 sm:pr-0"
                        >
                            <span class="sr-only">Edit</span>
                        </th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-200 bg-white">
                    <tr v-for="log in weightLogs" :key="log.id">
                        <td
                            class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900"
                        >
                            {{ log.log_date }}
                        </td>
                        <td
                            class="whitespace-nowrap px-2 py-2 text-sm text-gray-900"
                        >
                            {{ log.weight }} lbs
                        </td>
                        <td
                            class="whitespace-nowrap px-2 py-2 text-sm text-gray-500"
                        >
                            {{ log.body_fat_percentage }}%
                        </td>
                        <td
                            class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900"
                        >
                            {{ log.measurement_method }}
                        </td>
                        <td
                            class="relative whitespace-nowrap py-2 pl-3 pr-4 text-right text-sm font-medium sm:pr-0"
                        >
                            <!-- <a href="#" class="text-indigo-600 hover:text-indigo-900"
                    >Edit<span class="sr-only">, {{log.id }}</span></a
                  > -->
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <Modal :show="newEntryModal" @close="closeModal">
            <div class="p-6">
                <h2 class="text-lg font-medium text-gray-900">
                    Create a new entry
                </h2>

                <p class="mt-1 text-sm text-gray-600">
                    Log your weight and BF% for today.
                </p>

                <div class="mt-6">
                    <InputLabel for="Weight" value="Weight" class="sr-only" />
                    <form
                        @submit.prevent="submitNewEntry"
                        class="mt-6 space-y-6"
                    >
                        <!-- Weight Input -->
                        <div>
                            <InputLabel for="weight" value="Weight" />
                            <TextInput
                                id="weight"
                                v-model="form.weight"
                                type="number"
                                class="mt-1 block w-full"
                                placeholder="Enter weight in lbs"
                            />
                            <InputError
                                :message="form.errors.weight"
                                class="mt-2"
                            />
                        </div>

                        <!-- Body Fat Percentage Input -->
                        <div>
                            <InputLabel
                                for="body_fat_percentage"
                                value="Body Fat Percentage"
                            />
                            <TextInput
                                id="body_fat_percentage"
                                v-model="form.body_fat_percentage"
                                type="number"
                                class="mt-1 block w-full"
                                placeholder="Enter body fat percentage"
                            />
                            <InputError
                                :message="form.errors.body_fat_percentage"
                                class="mt-2"
                            />
                        </div>
                        <div>
                            <InputLabel
                                for="measurement_method"
                                value="Measurement Method"
                            />
                            <select
                                id="measurement_method"
                                v-model="form.measurement_method"
                                class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
                            >
                                <option disabled value="">
                                    Please select one
                                </option>
                                <option value="calipers">Calipers</option>
                                <option value="scale">Scale</option>
                                <option value="dexa">DEXA</option>
                                <option value="visual_estimation">
                                    Visual Estimation
                                </option>
                            </select>
                            <InputError
                                :message="form.errors.measurement_method"
                                class="mt-2"
                            />
                        </div>
                    </form>
                    <!-- 
                  <TextInput
                      id="weight"
                      ref="weightInput"
                     v-model="form.weight"
                      type="text"
                      class="mt-1 block w-3/4"
                      placeholder="Weight"
                     
                  /> -->

                    <!--  <InputError :message="form.errors.weight" class="mt-2" /> -->
                </div>

                <div class="mt-6 flex justify-end">
                    <SecondaryButton @click="closeModal">
                        Cancel
                    </SecondaryButton>

                    <PrimaryButton
                        class="ms-3"
                        :class="{ 'opacity-25': form.processing }"
                        :disabled="form.processing"
                        @click="createEntry"
                    >
                        Create Entry
                    </PrimaryButton>
                </div>
            </div>
        </Modal>

        <Modal :show="showImportModal" @close="closeImportModal">
            <div class="p-6">
                <div class="text-center">
                    <svg
                        class="mx-auto h-12 w-12 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            vector-effect="non-scaling-stroke"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                        />
                    </svg>
                    <h3 class="mt-2 text-sm font-semibold text-gray-900">
                        Import a CSV
                    </h3>
                    <p class="mt-1 text-sm text-gray-500">
                        Import a CSV file of your weight logs.
                    </p>
                    <div class="mt-6 mx-auto text-center">
                        <input
                            name="csvFile"
                            type="file"
                            @change="handleCSVFileChange"
                        />
                    </div>
                </div>

                <div class="mt-6 flex justify-end">
                    <SecondaryButton @click="closeImportModal">
                        Cancel
                    </SecondaryButton>
                    <PrimaryButton
                        class="ms-3"
                        :class="{ 'opacity-25': csvImportForm.processing }"
                        :disabled="csvImportForm.processing"
                        @click="importCSV"
                    >
                        Import
                    </PrimaryButton>
                </div>
            </div>
        </Modal>
    </div>
</template>

<script>
export default {
    props: {
        weightLogs: {
            type: Array,
            default: () => [],
        },
    },
};
</script>
<script setup>
import useForm from "@inertiajs/vue3";
import { PlusIcon } from "@heroicons/vue/24/solid";
import { ref } from "vue";
import Modal from "@/Components/Modal.vue";
import AuthenticatedLayout from "@/Layouts/AuthenticatedLayout.vue";
import InputLabel from "@/Components/InputLabel.vue";
import TextInput from "@/Components/TextInput.vue";
import InputError from "@/Components/InputError.vue";
import { useForm } from "@inertiajs/vue3";
import { usePage } from "@inertiajs/vue3";
import SecondaryButton from "@/Components/SecondaryButton.vue";
import PrimaryButton from "@/Components/PrimaryButton.vue";

const newEntryModal = ref(false);
const showImportModal = ref(false);

const form = useForm({
    weight: "",
    body_fat_percentage: "",
    measurement_method: "",
    //set log_date to today's date
    log_date: new Date().toISOString().slice(0, 10),
    //set log_time to current time
    log_time: new Date().toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    }),

    //set user_id to current user
    user_id: usePage().props.auth.user.id,
});

const importForm = () => {
    showImportModal.value = true;
};

const createEntry = () => {
    form.post(route("weight-logs.store"));
    newEntryModal.value = false;
};

const closeModal = () => {
    newEntryModal.value = false;

    form.reset();
};
const closeImportModal = () => {
    showImportModal.value = false;
    resetForm();
};
const importing = ref(false);

const newEntry = () => {
    newEntryModal.value = true;
};

const selectedFile = ref(null); // New ref to hold the file

const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
        // Example: Validate file size (e.g., 5MB limit)
        const maxSize = 4 * 1024 * 1024; // 5MB
        if (file.size > maxSize) {
            alert("File size should not exceed 4MB.");
            return;
        }

        // Example: Validate file type
        if (!file.type.includes("csv")) {
            alert("Only CSV files are allowed.");
            return;
        }

        selectedFile.value = file;
    }
};

const importCSV = () => {
    if (!selectedFile.value) {
        alert("Please select a file to import.");
        return;
    }

    let formData = new FormData();
    formData.append("file", selectedFile.value);

    form.post(route("weight-logs.import"), formData, {
        onSuccess: () => {
            alert("File imported successfully.");
            importing.value = false;
            showImportModal.value = false;
            resetForm();
        },
        onError: (errors) => {
            console.error("Upload error:", errors);
            importing.value = false;
            // Display a user-friendly error message
            if (errors && errors.file) {
                alert(`Error: ${errors.file}`);
            } else {
                alert("An error occurred during file upload.");
            }
        },
    });
};

const resetForm = () => {
    selectedFile.value = null;
};

const csvImportForm = useForm({
    csvFile: null, // A field specifically for the CSV file
});

const handleCSVFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
        // ...validation for file size and type...

        csvImportForm.csvFile = file; // Set the file to the csvImportForm
    }
};

const importCSV = () => {
    if (!csvImportForm.csvFile) {
        alert("Please select a file to import.");
        return;
    }

    csvImportForm.post(route("weight-logs.import"), {
        onSuccess: () => {
            // ...success handling...
        },
        onError: (errors) => {
            // ...error handling...
        },
    });
};

const resetCSVForm = () => {
    csvImportForm.reset("csvFile"); // Reset the CSV file field
};
</script>



The updated Vue component looks well-structured for handling both the creation of new weight log entries and the import of CSV files, each with its own distinct form. However, there seems to be a small oversight: the `importCSV` function is declared twice with the same name, which could cause a conflict. You should rename one of them to avoid this issue.

Here's the corrected script setup, with distinct names for each `importCSV` function:

### Script Setup with Distinct Function Names

```javascript
<script setup>
import { ref } from "vue";
import { useForm } from "@inertiajs/vue3";
import Modal from "@/Components/Modal.vue";
import InputLabel from "@/Components/InputLabel.vue";
import TextInput from "@/Components/TextInput.vue";
import InputError from "@/Components/InputError.vue";
import SecondaryButton from "@/Components/SecondaryButton.vue";
import PrimaryButton from "@/Components/PrimaryButton.vue";
import { usePage } from "@inertiajs/vue3";

const newEntryModal = ref(false);
const showImportModal = ref(false);

// Form for adding new entries
const form = useForm({
    weight: "",
    body_fat_percentage: "",
    measurement_method: "",
    log_date: new Date().toISOString().slice(0, 10),
    log_time: new Date().toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    }),
    user_id: usePage().props.auth.user.id,
});

const createEntry = () => {
    form.post(route("weight-logs.store"));
    newEntryModal.value = false;
};

const closeModal = () => {
    newEntryModal.value = false;
    form.reset();
};

const newEntry = () => {
    newEntryModal.value = true;
};

// Form for CSV file import
const csvImportForm = useForm({
    csvFile: null,
});

const selectedFile = ref(null);

const handleCSVFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
        // Validation for file size and type...
        csvImportForm.csvFile = file;
    }
};

const importCSVFile = () => { // Renamed function
    if (!csvImportForm.csvFile) {
        alert("Please select a file to import.");
        return;
    }

    csvImportForm.post(route("weight-logs.import"), {
        onSuccess: () => {
            // Success handling...
        },
        onError: (errors) => {
            // Error handling...
        },
    });
};

const closeImportModal = () => {
    showImportModal.value = false;
    csvImportForm.reset("csvFile");
};

const importForm = () => {
    showImportModal.value = true;
};

const resetForm = () => {
    selectedFile.value = null;
};
</script>
```

### Key Points

1. **Function Names**: The `importCSV` function for handling CSV file uploads has been renamed to `importCSVFile` to avoid conflict with any other functions.

2. **Separate Forms**: There are two separate Inertia forms - `form` for new weight log entries and `csvImportForm` for CSV imports. Each form has its own submission function and error handling.

3. **Modal Management**: Functions `closeModal` and `closeImportModal` are used to handle the closing of the respective modals.

4. **File Input Handling**: `handleCSVFileChange` is specifically for handling the CSV file input.

By maintaining distinct and appropriately named functions and forms, your component should function smoothly, allowing users to add new entries and import CSV files independently.
