
Based on your code and description, it seems like you're close to getting the file upload to work, but there are a few things that might be causing the issue:

1. **File Upload Handling**: Ensure that the file is being correctly attached and sent in the form data.

2. **Response Handling**: Properly handle the server response to determine if the upload was successful or if there was an error.

3. **Modal State**: The modal should close only when the upload is successful.

Let's troubleshoot each part:

### File Upload Handling

From your `importCSV` method, it looks like you are correctly appending the file to `FormData` and making a POST request. However, ensure that:

- The `selectedFile` actually contains the file data. You can console log `selectedFile.value` before appending it to `FormData` to verify this.
- The `route('weight-logs.import')` is the correct endpoint and it matches the route defined in your Laravel routes file.

### Response Handling

The `onSuccess` and `onError` callbacks are a good start. However, it's crucial to understand how your Laravel application is handling the request. Make sure that:

- Laravel is returning a proper response. For a successful upload, it should return a redirect response (possibly with a success message).
- For errors, Laravel should send back an error response which you can log or display. You can also inspect the network request in the browser's developer tools to see the response from the server.

### Modal State

Your modal should close only after a successful upload. If there's an error, it should remain open, and you should display an error message to the user. You can use a reactive variable to show an error message inside your modal.

### Suggested Changes

Here are some changes you can make to debug and possibly fix the issue:

1. **Add Console Logs for Debugging**:

   ```javascript
   const importCSV = () => {
     console.log("Importing file:", selectedFile.value);
     // Rest of your code...
   };
   ```

2. **Check Network Request**:

   - Open the browser's developer tools and go to the Network tab.
   - Trigger the file upload and inspect the request made to `weight-logs.import`. Check the request payload to see if the file is included and review the response.

3. **Server-side Debugging**:

   - In your Laravel controller, add log statements to check if the file is being received and processed correctly.

4. **Improve Error Handling**:

   - Show an error message in the modal if the upload fails. This will give you and the user immediate feedback if something goes wrong.

If after these checks, the issue still persists, it might be helpful to look into the server-side processing of the file in your Laravel application to ensure that it's handling the file correctly and returning the appropriate response.


i added the console logging code. nothing logs in console when i click import 


If nothing is logging to the console when you click the "Import" button, it indicates that the `importCSV` method may not be getting called at all. This could be due to a few different reasons:

### 1. Event Handler Not Triggering

Ensure that the "Import" button in your modal is correctly wired up to call the `importCSV` method. It’s possible that the event handler is not set up correctly or is pointing to a different method.

### 2. Check the Button's `@click` Directive

Make sure that the button intended to trigger the file upload is correctly using the `@click` directive to call `importCSV`.

```vue
<PrimaryButton
    class="ms-3"
    :class="{ 'opacity-25': form.processing }"
    :disabled="form.processing"
    @click="importCSV"  <!-- Ensure this is correct -->
>
    Import
</PrimaryButton>
```

### 3. Review Vue Component Structure

Vue's reactivity system can sometimes be finicky with how methods are defined and used, especially with the Composition API and the Options API being mixed. Make sure your methods are correctly defined within the scope where they're being used.

### 4. Check for Errors in Console

Apart from the custom console log you added, check if there are any other errors in the browser console that might be preventing the method from being executed. JavaScript errors elsewhere in your code can sometimes halt execution of subsequent scripts.

### 5. Vue DevTools

If you have Vue DevTools installed in your browser, use it to inspect the state of your component. Check if the `importCSV` method is correctly registered as an event handler for the button.

### 6. Verify Modal Component Functionality

If your modal component (`Modal`) is a custom component, ensure that it's not interfering with the event handling. Sometimes custom components can inadvertently stop event propagation or not pass events correctly.

### 7. Hard Refresh the Browser

Sometimes, the browser might be using a cached version of your JavaScript. Perform a hard refresh (usually `Ctrl + F5` on Windows or `Command + Shift + R` on Mac) to make sure the latest version of your script is loaded.

### 8. Simplify the Test

As a test, try replacing the `importCSV` method with a simple method that just logs to the console, and wire it to the button. This can help determine if the issue is with the method itself or the way it's being called:

```javascript
const testImport = () => {
  console.log("Test import function called");
};
```

If this basic function works, then the issue likely lies within the `importCSV` method. If it doesn’t, the problem is more likely with how events are wired in your component.


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

        <Modal :show="showImportModal" @close="Modal">
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
                        <input type="file" @change="handleFileChange" />
                    </div>
                </div>
                <div class="mt-6">
                    <form
                        @submit.prevent="importCSV"
                        class="mt-6 space-y-6"
                    ></form>
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
const importing = ref(false);

const newEntry = () => {
    newEntryModal.value = true;
};

const selectedFile = ref(null); // New ref to hold the file

const handleFileChange = (event) => {
    selectedFile.value = event.target.files[0];
};

const importCSV = () => {
    console.log("Importing files: ", selectedFile.value);
    importing.value = true;
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
        },
        onError: (errors) => {
            importing.value = false;
            console.error(errors);
        },
    });
};
</script>



Based on your updated code, it seems you've correctly implemented the file upload logic, but there are a couple of issues that might be causing the problem:

1. **Misplaced `@click` Directive**: In the modal for importing CSV, the `@click` directive for the "Import" button is calling `createEntry` instead of `importCSV`. This means that when you click "Import," it's not triggering the file upload logic but instead trying to create a new entry.

2. **Form Submission**: The form in the import modal does not have any submit button, and even if it did, it wouldn't trigger the `importCSV` function because the `@submit.prevent` is on an empty form.

Here's how you can fix these issues:

### Fix the `@click` Directive

Update the "Import" button in your import modal to call `importCSV` instead of `createEntry`:

```vue
<PrimaryButton
    class="ms-3"
    :class="{ 'opacity-25': form.processing }"
    :disabled="form.processing"
    @click="importCSV"  <!-- This should call importCSV -->
>
    Import
</PrimaryButton>
```

### Remove the Empty Form

The empty form tag in your import modal is unnecessary. You can safely remove it:

```vue
<div class="mt-6">
    <!-- Removed empty form tag -->
</div>
```

### Ensure Console Log in `importCSV`

Double-check that your console log statement is the first line in your `importCSV` method. This will confirm if the method is being called:

```javascript
const importCSV = () => {
    console.log("Importing files: ", selectedFile.value); // This should be the first line
    // Rest of the code...
};
```

### Debugging Steps

- After making these changes, test the import functionality again.
- Open your browser's developer tools and observe the console for the log statement when you click "Import."
- Also, check the Network tab to see if the request is being sent to the server and inspect the response.

With these adjustments, your import functionality should work correctly, and you'll be able to determine if the file is being sent to the server.


ok that fixed it. now we need to visually indicate any errors or show file upload progress to the user


Great to hear that the issue with the file upload is fixed! Now, let's add visual feedback for the user during the file upload process, including error handling and progress indication.

### 1. Showing Upload Progress

To show upload progress, you need to handle the progress events of the request. This can be a bit tricky with Inertia.js, as it abstracts the lower-level details of the request. However, you can use the native fetch API or axios to handle this.

Here's an example using axios:

```javascript
import axios from 'axios';

const uploadFile = async () => {
    if (!selectedFile.value) {
        alert('Please select a file to import.');
        return;
    }

    let formData = new FormData();
    formData.append("file", selectedFile.value);

    try {
        const response = await axios.post(route('weight-logs.import'), formData, {
            onUploadProgress: progressEvent => {
                let percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                // Update your progress bar here
                console.log(percentCompleted);
            }
        });
        // Handle success
        alert('File imported successfully.');
        showImportModal.value = false;
    } catch (error) {
        // Handle error
        console.error(error);
    }
}
```

### 2. Displaying Error Messages

For displaying error messages, you can use a reactive variable that holds the error message. Update this variable whenever there's an error, and display it in your modal.

First, define the error message reactive variable:

```javascript
const errorMessage = ref('');
```

Then, update it in the catch block of your upload logic:

```javascript
try {
    // File upload logic...
} catch (error) {
    errorMessage.value = error.response.data.message || 'An error occurred while uploading the file.';
}
```

Finally, display the error message in your modal:

```vue
<Modal :show="showImportModal" @close="closeModal">
    <!-- Modal content... -->

    <div v-if="errorMessage" class="text-red-500">
        {{ errorMessage }}
    </div>

    <!-- Rest of the modal content... -->
</Modal>
```

### 3. Adding a Progress Bar

You can add a simple progress bar in your modal to visually indicate the upload progress. Here's a basic example:

Add a reactive variable for tracking progress:

```javascript
const uploadProgress = ref(0);
```

Update it in the `onUploadProgress` event:

```javascript
onUploadProgress: progressEvent => {
    uploadProgress.value = Math.round((progressEvent.loaded * 100) / progressEvent.total);
}
```

Display the progress bar in your modal:

```vue
<Modal :show="showImportModal" @close="closeModal">
    <!-- Modal content... -->

    <div v-if="uploadProgress !== 0" class="w-full bg-gray-200 rounded-full dark:bg-gray-700">
        <div :style="{ width: uploadProgress + '%' }" class="bg-blue-600 text-xs font-medium text-blue-100 text-center p-0.5 leading-none rounded-full"> {{ uploadProgress }}% </div>
    </div>

    <!-- Rest of the modal content... -->
</Modal>
```

With these changes, your users should have a better experience with visual feedback during the file upload process, including progress indication and error messages.


{
  "component": "Dashboard",
  "props": {
    "errors": {
      "file": "The file field is required."
    },
    "auth": {
      "user": {
        "id": 4,
        "name": "Tim White",
        "email": "t@timwhite.co",
        "email_verified_at": null,
        "created_at": "2023-11-30T20:52:12.000000Z",
        "updated_at": "2023-11-30T20:52:12.000000Z",
        "height": "193.00",
        "age": 32,
        "gender": "male"
      }
    },
    "ziggy": {
      "url": "http://127.0.0.1:8000",
      "port": 8000,
      "defaults": [],
      "routes": {
        "sanctum.csrf-cookie": {
          "uri": "sanctum/csrf-cookie",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "ignition.healthCheck": {
          "uri": "_ignition/health-check",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "ignition.executeSolution": {
          "uri": "_ignition/execute-solution",
          "methods": [
            "POST"
          ]
        },
        "ignition.updateConfig": {
          "uri": "_ignition/update-config",
          "methods": [
            "POST"
          ]
        },
        "dashboard": {
          "uri": "dashboard",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "weightLog.create": {
          "uri": "weight-log",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "weight-logs.store": {
          "uri": "weight-logs",
          "methods": [
            "POST"
          ]
        },
        "weight-logs.import": {
          "uri": "weight-logs/import",
          "methods": [
            "POST"
          ]
        },
        "weightLog.store": {
          "uri": "weight-log",
          "methods": [
            "POST"
          ]
        },
        "weightLog.index": {
          "uri": "weight-log/history",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "profile.edit": {
          "uri": "profile",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "profile.update": {
          "uri": "profile",
          "methods": [
            "PATCH"
          ]
        },
        "profile.destroy": {
          "uri": "profile",
          "methods": [
            "DELETE"
          ]
        },
        "register": {
          "uri": "register",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "login": {
          "uri": "login",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "password.request": {
          "uri": "forgot-password",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "password.email": {
          "uri": "forgot-password",
          "methods": [
            "POST"
          ]
        },
        "password.reset": {
          "uri": "reset-password/{token}",
          "methods": [
            "GET",
            "HEAD"
          ],
          "parameters": [
            "token"
          ]
        },
        "password.store": {
          "uri": "reset-password",
          "methods": [
            "POST"
          ]
        },
        "verification.notice": {
          "uri": "verify-email",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "verification.verify": {
          "uri": "verify-email/{id}/{hash}",
          "methods": [
            "GET",
            "HEAD"
          ],
          "parameters": [
            "id",
            "hash"
          ]
        },
        "verification.send": {
          "uri": "email/verification-notification",
          "methods": [
            "POST"
          ]
        },
        "password.confirm": {
          "uri": "confirm-password",
          "methods": [
            "GET",
            "HEAD"
          ]
        },
        "password.update": {
          "uri": "password",
          "methods": [
            "PUT"
          ]
        },
        "logout": {
          "uri": "logout",
          "methods": [
            "POST"
          ]
        }
      },
      "location": "http://127.0.0.1:8000/dashboard"
    },
    "weightLogs": [
      {
        "id": 30,
        "user_id": 4,
        "weight": 123,
        "body_fat_percentage": 12,
        "measurement_method": "calipers",
        "log_date": "2023-12-02",
        "log_time": "11:19:00",
        "created_at": "2023-12-02T19:19:44.000000Z",
        "updated_at": "2023-12-02T19:19:44.000000Z"
      },
      {
        "id": 31,
        "user_id": 4,
        "weight": 12,
        "body_fat_percentage": 12,
        "measurement_method": "scale",
        "log_date": "2023-12-02",
        "log_time": "11:19:00",
        "created_at": "2023-12-02T19:20:05.000000Z",
        "updated_at": "2023-12-02T19:20:05.000000Z"
      },
      {
        "id": 32,
        "user_id": 4,
        "weight": 123,
        "body_fat_percentage": 12,
        "measurement_method": "scale",
        "log_date": "2023-12-02",
        "log_time": "11:21:00",
        "created_at": "2023-12-02T19:21:52.000000Z",
        "updated_at": "2023-12-02T19:21:52.000000Z"
      },
      {
        "id": 33,
        "user_id": 4,
        "weight": 12,
        "body_fat_percentage": 12,
        "measurement_method": "calipers",
        "log_date": "2023-12-02",
        "log_time": "12:17:00",
        "created_at": "2023-12-02T20:18:10.000000Z",
        "updated_at": "2023-12-02T20:18:10.000000Z"
      }
    ],
    "ffmi": 13.180702322209992,
    "leanBodyMass": 108.23978298312959
  },
  "url": "/dashboard",
  "version": ""
}


The JSON structure you provided gives a good overview of the data being passed to your Vue component, particularly the `Dashboard` component. It appears you are handling various functionalities like user authentication, displaying weight logs, and handling file imports.

Given this context, let's focus on how to visually indicate errors (such as the file upload error shown in the `errors` object) and show file upload progress to the user.

### Displaying Errors

To display errors, you can use the `errors` object provided in your props. Here's an example of how you might show the file upload error:

1. **Display Error Message**: Modify the `Modal` component used for file import to include an area for displaying error messages.

```vue
<Modal :show="showImportModal" @close="closeModal">
    <!-- Other modal content -->

    <div v-if="errors.file" class="text-red-500 mt-2">
        {{ errors.file }}
    </div>

    <!-- Rest of the modal content -->
</Modal>
```

2. **Pass Errors Prop to Component**: Ensure that the `errors` object is correctly passed to your component. It seems like you're already doing this, but just double-check that it's included in your component's props:

```javascript
export default {
    props: {
        weightLogs: Array,
        errors: Object,
        // ... other props
    },
    // ... rest of the component setup
};
```

### Showing File Upload Progress

For file upload progress, as mentioned in a previous response, you'll need to handle the progress event of your file upload request. However, since you are using Inertia.js, which abstracts away these lower-level details, you might consider using Axios directly for the file upload to handle progress events.

1. **Add a Progress Bar**: Add a simple progress bar in your modal.

```vue
<Modal :show="showImportModal" @close="closeModal">
    <!-- Other modal content -->

    <div v-if="uploadProgress !== 0" class="mt-2">
        <div class="bg-gray-200 rounded h-2">
            <div class="bg-blue-600 h-2 rounded" :style="{ width: uploadProgress + '%' }"></div>
        </div>
    </div>

    <!-- Rest of the modal content -->
</Modal>
```

2. **Update Progress on Upload**: When performing the file upload, update the `uploadProgress` reactive variable to reflect the current progress. This can be done using Axios with an `onUploadProgress` event handler, as described in the previous response.

Remember to reset the `uploadProgress` and error messages appropriately when the modal is closed or when a new file upload is initiated.

By implementing these changes, your application will provide immediate, visual feedback to the user about any errors that occur during file upload and will visually indicate the progress of the
