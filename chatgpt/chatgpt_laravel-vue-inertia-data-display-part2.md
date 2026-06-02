
Creating a Vue file upload component for your Laravel application with Vue and Inertia involves several steps. The component will provide a user interface for uploading a file (in this case, a CSV file containing weight log data) which will then be sent to the server for processing. Here's a step-by-step guide:

### 1. Create a New Vue Component

Start by creating a new Vue component file. This can be done in your Vue components directory. For example, create a file named `WeightLogImport.vue`.

### 2. Template Section

In the `WeightLogImport.vue` file, define the template section, which includes the form with a file input and a submit button.

```vue
<template>
  <div>
    <form @submit.prevent="uploadFile">
      <input type="file" @change="handleFileUpload" />
      <button type="submit">Upload</button>
    </form>
  </div>
</template>
```

- `@submit.prevent` is a Vue directive that prevents the default form submission action and calls the `uploadFile` method instead.
- `@change` on the file input calls `handleFileUpload` method whenever a file is selected.

### 3. Script Section

In the script section, define the data properties and methods for handling file selection and upload.

```vue
<script>
export default {
  data() {
    return {
      selectedFile: null,
    };
  },
  methods: {
    handleFileUpload(event) {
      this.selectedFile = event.target.files[0];
    },
    async uploadFile() {
      const formData = new FormData();
      formData.append('file', this.selectedFile);

      try {
        const response = await this.$inertia.post('/api/upload-weight-log', formData);
        // Handle response
      } catch (error) {
        // Handle error
      }
    }
  }
};
</script>
```

- `selectedFile` holds the file selected by the user.
- `handleFileUpload` method updates `selectedFile` with the chosen file.
- `uploadFile` method sends the file to the server using Inertia's POST method. Replace `'/api/upload-weight-log'` with the actual route in your Laravel application that handles the file upload.

### 4. Style Section (Optional)

You can add a style section to style the form and button if needed.

```vue
<style scoped>
/* Add your CSS styles here */
</style>
```

### 5. Integrate the Component in Your Application

Once the component is ready, you need to integrate it into your application. This can be done by importing it into a parent component or adding it to a specific route where you want the upload feature to be available.

### 6. Handle the Uploaded File in Laravel

On the server side, in your Laravel application, ensure you have a route and controller method set up to handle the file upload. This method should process the uploaded file, parse its contents, and store the data in your database.

### 7. Testing

Test the file upload feature thoroughly to ensure that it can handle different file sizes, types, and potential upload errors gracefully.

By following these steps, you'll create a Vue component that allows users to upload weight log data files. Ensure to handle server responses and errors properly to provide a smooth user experience.


ok walk me through intergrating it by adding it to a route


Integrating your Vue file upload component (`WeightLogImport.vue`) into your Laravel application with Inertia involves a few steps. These include updating your web routes, possibly creating or modifying a controller method, and ensuring that your Vue component is rendered when the route is accessed.

### 1. Create or Update a Laravel Controller Method

First, ensure you have a controller method in Laravel to handle the rendering of the page where the upload will occur. This method should use Inertia to render your Vue component.

For instance, in your `WeightLogController`, you might have:

```php
use Inertia\Inertia;

class WeightLogController extends Controller
{
    // Other methods...

    public function importForm()
    {
        return Inertia::render('WeightLogImport');
    }

    // Other methods...
}
```

### 2. Update Web Routes in Laravel

Next, define a route in your `web.php` (or a similar routes file) that points to this controller method.

```php
use App\Http\Controllers\WeightLogController;

// Other routes...

Route::get('/weight-log/import', [WeightLogController::class, 'importForm'])->name('weightLog.importForm');

// Other routes...
```

### 3. Integrate Vue Component with Inertia

In your `resources/js/Pages` directory (or wherever you store your Inertia pages), create the `WeightLogImport.vue` component as previously described.

Ensure that the name of the Vue component file matches what you're rendering in the Laravel controller. In this case, the file should be named `WeightLogImport.vue`.

### 4. Link to the Import Page

In your Vue app, you'll want to provide a way for users to navigate to this new import page. This can be done by adding a link in a relevant component, such as a navigation bar or dashboard.

For example, in your `Dashboard.vue` component, you could add:

```vue
<template>
  <!-- ... other content ... -->
  <inertia-link :href="route('weightLog.importForm')">Import Weight Log</inertia-link>
  <!-- ... other content ... -->
</template>
```

### 5. Handle File Upload Submission

Don't forget to handle the file upload on the server side. You'll need another controller method in Laravel to process the uploaded file. This method would typically be accessed via a POST route.

For instance:

```php
// In WeightLogController

public function uploadFile(Request $request)
{
    $request->validate(['file' => 'required|file']);

    // Process file...

    return redirect()->back()->with('message', 'File uploaded successfully.');
}
```

And add a corresponding route in `web.php`:

```php
Route::post('/weight-log/upload', [WeightLogController::class, 'uploadFile'])->name('weightLog.uploadFile');
```

### 6. Test the Integration

After setting up the route, controller method, and Vue component, test the entire flow:

- Navigate to the import page via the link in your Vue app.
- Try uploading a file and ensure that it's processed correctly by your Laravel backend.
- Check for any errors or issues in the process and refine as necessary.

By following these steps, you'll have integrated the file upload feature into your Laravel application using Vue and Inertia. The users of your application will be able to access a dedicated page to import their weight log data.


runtime-core.esm-bundler.js:221 Uncaught Error: Ziggy error: route 'weight-logs.import' is not in the route list.


The error message you're encountering, `Uncaught Error: Ziggy error: route 'weight-logs.import' is not in the route list`, indicates that the Vue component is trying to reference a route named `'weight-logs.import'` which Ziggy cannot find in the list of routes it knows about. Ziggy is a package that allows your JavaScript to access your Laravel routes.

Here's how to troubleshoot and resolve this issue:

### 1. Check Route Name in Laravel

Firstly, ensure that the route is correctly defined in your Laravel routes file (`web.php` or similar). The route name in Laravel should match what you are trying to reference in your Vue component.

For example, in your `web.php`, the route might be defined as:

```php
Route::get('/weight-logs/import', [WeightLogController::class, 'importForm'])->name('weight-logs.import');
```

Make sure that the name given in the `name()` method is exactly `'weight-logs.import'`.

### 2. Clear Cached Routes

If you've recently added or changed the name of the route, Laravel might be using an outdated cached version of your routes. You can clear the route cache by running:

```bash
php artisan route:clear
```

### 3. Regenerate Ziggy's Route List

Ziggy might be working with an outdated list of routes. To regenerate Ziggy's route list, you can use:

```bash
php artisan ziggy:generate
```

This command will generate a fresh `routes.js` file (or similar, depending on your Ziggy configuration), which contains all of your Laravel routes.

### 4. Check the Ziggy Configuration in Vue

Make sure that you're importing and using Ziggy correctly in your Vue component. If you're using the `route` helper provided by Ziggy, it should have access to the latest routes.

### 5. Check Vue Component

In your Vue component, ensure that the route name matches exactly with the Laravel route name. For instance:

```vue
<inertia-link :href="route('weight-logs.import')">Import Weight Log</inertia-link>
```

### 6. Rebuild Frontend Assets

If you have made changes to your JavaScript or Vue files, remember to recompile your frontend assets. Depending on your setup, this might be done with:

```bash
npm run dev
# or

**Related:** [[coding_web_dev]]
npm run production
```

### 7. Refresh and Test

After performing these steps, refresh your application in the browser to see if the issue is resolved.

If the problem persists, double-check the route names for typos or inconsistencies, and ensure that Ziggy is properly configured and loaded in your application.


ok so i worked on the import method. here is my controller:
<?php

namespace App\Http\Controllers;


use App\Http\Requests\ProfileUpdateRequest;
use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Redirect;
use Inertia\Inertia;
use Inertia\Response;
use App\Models\WeightLog;

class WeightLogController extends Controller
{
    // Method to display the form for logging weight
    public function create()
    {
        return Inertia::render('WeightLog/Create'); // This should match the Vue component's file path
    }

    // Method to display the form for importing data
    public function importForm()
    {
        return Inertia::render('WeightLog/Import'); // Adjust to your Vue component's file path
    }

    //Method to import existing weight data from a CSV file
    public function import(Request $request)
    {
        $request->validate(['file' => 'required|file|mimes:csv,txt']);

        $path = $request->file('file')->getRealPath();
        $data = array_map('str_getcsv', file($path));
        $header = array_shift($data); // Remove header row
        $userId = auth()->id();
        $measurementMethod = str_contains($request->file('file')->getClientOriginalName(), 'renpho') ? 'scale' : 'other';

        foreach ($data as $row) {
            $rowData = array_combine($header, $row);

            // Extract date and time from the 'Time of Measurement' column
            $dateTime = new \DateTime($rowData['Time of Measurement']);
            $logDate = $dateTime->format('Y-m-d');
            $logTime = $dateTime->format('H:i:s');

            WeightLog::updateOrCreate(
                [
                    'user_id' => $userId,
                    'log_date' => $logDate,
                    // Add other unique identifiers if necessary
                ],
                [
                    'weight' => $rowData['Weight'], // Replace with actual column name
                    'body_fat_percentage' => $rowData['Body Fat Percentage'], // Replace with actual column name
                    'measurement_method' => $measurementMethod,
                    'log_date' => $logDate,
                    'log_time' => $logTime,
                    // Add other data fields
                ]
            );
        }

        return redirect()->route('weightLog.index');
    }



    public function dashboard()
    {
        $userId = auth()->id();
        $user = Auth::user();

        $weightLogs = WeightLog::where('user_id', $userId)
            ->orderBy('log_date', 'desc')
            ->take(7) // Last 7 days data
            ->get();

        // Assuming height is stored in centimeters in the user model and weight in pounds
        $heightInMeters = $user->height / 100;
        $latestLog = $weightLogs->first();

        if ($latestLog) {
            $weightInKg = $latestLog->weight * 0.453592; // Convert pounds to kilograms
            $bodyFatPercentage = $latestLog->body_fat_percentage;
            $leanBodyMass = $weightInKg * (1 - $bodyFatPercentage / 100);
            $ffmi = $leanBodyMass / ($heightInMeters * $heightInMeters);
            $leanBodyMassInPounds = $leanBodyMass * 2.20462; // Convert Lean Body Mass to pounds

        } else {
            $ffmi = null; // Handle case where there are no weight logs
            $leanBodyMassInPounds = null; // Handle case where there are no weight logs

        }

        return Inertia::render('Dashboard', [
            'weightLogs' => $weightLogs,
            'ffmi' => $ffmi ?? null,
            'leanBodyMass' => $leanBodyMassInPounds, // Send Lean Body Mass in pounds to frontend
            // Include other data as needed
        ]);
    }






    // Method to handle the form submission for logging new weight data
    public function store(Request $request)
    {
        $request->validate([
            'weight' => 'required|numeric',
            'body_fat_percentage' => 'required|numeric',
            'measurement_method' => 'required|string',
            'log_date' => 'required|date',
            'log_time' => 'required',
        ]);

        WeightLog::create([
            'user_id' => auth()->id(),
            'weight' => $request->weight,
            'body_fat_percentage' => $request->body_fat_percentage,
            'measurement_method' => $request->measurement_method,
            'log_date' => $request->log_date,
            'log_time' => $request->log_time,
        ]);

        return redirect()->back()->with('weightLogs', WeightLog::all());
    }

    // Method to display a user's weight log history
    // WeightLogController.php

    public function index()
    {
        $weightLogs = WeightLog::where('user_id', auth()->id())->get();

        return inertia('WeightLog/Index', [
            'weightLogs' => $weightLogs,
        ]);
    }
}


and here is my vue component
<template>
   <div>
      <div class="px-4 py-6">

  
      <div class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1 class="text-base font-semibold leading-6 text-gray-900">Body Tracking </h1>
        <p class="mt-2 text-sm text-gray-700">The table below shows your weight and body composition changes for each day you've logged them.</p>
      </div>
      <div class="mt-4 sm:ml-16 space-y-2 sm:mt-0 sm:flex-none">
        <button @click="newEntry()" type="button" class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Add Entry</button>
        <button @click="importForm()"
        
        type="button" class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Import
        </button>
    </div>
    </div>
   
          <table class="min-w-full divide-y divide-gray-300">
              
            <thead>
              <tr>
                <th scope="col" class="whitespace-nowrap py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">Date</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">Weight</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">BF %</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">Method</th>
               
                <th scope="col" class="relative whitespace-nowrap py-3.5 pl-3 pr-4 sm:pr-0">
                  <span class="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white">
              <tr v-for="log in weightLogs" :key="log.id">
               
                <td class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900">{{ log.log_date }}</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm text-gray-900">{{ log.weight }} lbs</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm text-gray-500">{{ log.body_fat_percentage }}%</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900">{{ log.measurement_method }}</td>
               <td class="relative whitespace-nowrap py-2 pl-3 pr-4 text-right text-sm font-medium sm:pr-0">
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
                   <form @submit.prevent="submitNewEntry" class="mt-6 space-y-6">
         
             <!-- Weight Input -->
             <div>
                  <InputLabel for="weight" value="Weight" />
                  <TextInput id="weight" v-model="form.weight" type="number" class="mt-1 block w-full" placeholder="Enter weight in lbs" />
                  <InputError :message="form.errors.weight" class="mt-2" />
              </div>

              <!-- Body Fat Percentage Input -->
              <div>
                  <InputLabel for="body_fat_percentage" value="Body Fat Percentage" />
                  <TextInput id="body_fat_percentage" v-model="form.body_fat_percentage" type="number" class="mt-1 block w-full" placeholder="Enter body fat percentage" />
                  <InputError :message="form.errors.body_fat_percentage" class="mt-2" />
              </div>
              <div>
                  <InputLabel for="measurement_method" value="Measurement Method" />
                  <select id="measurement_method" v-model="form.measurement_method" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50">
                      <option disabled value="">Please select one</option>
                      <option value="calipers">Calipers</option>
                      <option value="scale">Scale</option>
                      <option value="dexa">DEXA</option>
                      <option value="visual_estimation">Visual Estimation</option>
                  </select>
                  <InputError :message="form.errors.measurement_method" class="mt-2" />
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
                  <SecondaryButton @click="closeModal"> Cancel </SecondaryButton>

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
              <h2 class="text-lg font-medium text-gray-900">
                 Import existing weight logs
              </h2>

              <p class="mt-1 text-sm text-gray-600">
                Import a CSV file of your weight logs.
              </p>

          <div class="mt-6">
                  <InputLabel for="Weight" value="Weight" class="sr-only" />
                  <input type="file" @change="importCSV" />


                   <form @submit.prevent="importCSV" class="mt-6 space-y-6">
         
             <!-- Weight Input -->
             <!-- <div>
                  <InputLabel for="weight" value="Weight" />
                  <TextInput id="weight" v-model="form.weight" type="number" class="mt-1 block w-full" placeholder="Enter weight in lbs" />
                  <InputError :message="form.errors.weight" class="mt-2" />
              </div> -->

              <!-- Body Fat Percentage Input -->
              <!-- <div>
                  <InputLabel for="body_fat_percentage" value="Body Fat Percentage" />
                  <TextInput id="body_fat_percentage" v-model="form.body_fat_percentage" type="number" class="mt-1 block w-full" placeholder="Enter body fat percentage" />
                  <InputError :message="form.errors.body_fat_percentage" class="mt-2" />
              </div>
              <div>
                  <InputLabel for="measurement_method" value="Measurement Method" />
                  <select id="measurement_method" v-model="form.measurement_method" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50">
                      <option disabled value="">Please select one</option>
                      <option value="calipers">Calipers</option>
                      <option value="scale">Scale</option>
                      <option value="dexa">DEXA</option>
                      <option value="visual_estimation">Visual Estimation</option>
                  </select>
                  <InputError :message="form.errors.measurement_method" class="mt-2" />
              </div> -->
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
                  <SecondaryButton @click="closeModal"> Cancel </SecondaryButton>

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
import { ref } from 'vue';
import Modal from '@/Components/Modal.vue';
import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout.vue';
import InputLabel from '@/Components/InputLabel.vue';
import TextInput from '@/Components/TextInput.vue';
import InputError from '@/Components/InputError.vue';
import { useForm } from '@inertiajs/vue3';
import { usePage } from '@inertiajs/vue3';
import SecondaryButton from '@/Components/SecondaryButton.vue';
import PrimaryButton from '@/Components/PrimaryButton.vue';

const newEntryModal = ref(false);
const showImportModal = ref(false);
const form = useForm({
  weight: '',
  body_fat_percentage: '',
  measurement_method: '',
  //set log_date to today's date
  log_date: new Date().toISOString().slice(0, 10),
  //set log_time to current time
  log_time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }),

  //set user_id to current user
  user_id: usePage().props.auth.user.id,

});

const importForm = () => {
 
  showImportModal.value = true;
};

const importCSV = () => {
  form.post(route('weight-logs.import'));
  showImportModal.value = false;
};

const createEntry = () => {
  form.post(route('weight-logs.store'));
  newEntryModal.value = false;
};

const closeModal = () => {
  newEntryModal.value = false;

  form.reset();
};

const newEntry = () => {
  newEntryModal.value = true;
};




</script>


when i click import, the modal opens and i can pick a file, but then nothing happens when i click import and i get this error int he browser console:



The issue you're encountering seems to be related to how the file upload process is being handled in your Vue component. From your description, it appears that the actual file selected by the user is not being sent to the server when the "Import" button is clicked. This is likely due to the form data not being correctly prepared or the file not being attached to the request.

Let's address the issue in two parts: updating the `importCSV` method to properly handle the file upload, and ensuring that the server-side route and controller method are correctly set up to receive and process this file.

### Updating the `importCSV` Method

1. **Attach the File to FormData**: In the `importCSV` method, you need to create a `FormData` object and append the selected file to it.

2. **Send the FormData to the Server**: Use Inertia's `post` method to send this FormData to the server.

Here's how you can modify the `importCSV` method:

```javascript
const selectedFile = ref(null); // New ref to hold the file

const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
};

const importCSV = () => {
  if (!selectedFile.value) {
    alert('Please select a file to import.');
    return;
  }

  let formData = new FormData();
  formData.append('file', selectedFile.value);

  form.post(route('weight-logs.import'), formData, {
    onSuccess: () => {
      alert('File imported successfully.');
      showImportModal.value = false;
    },
    onError: (errors) => {
      console.error(errors);
    }
  });
};
```

And in your template, bind the `handleFileChange` method to the file input:

```vue
<input type="file" @change="handleFileChange" />
```

### Ensure the Server-Side is Set Up Correctly

1. **Route**: Verify that you have a route defined in Laravel's `web.php` for the `'weight-logs.import'` endpoint. It should look something like this:

   ```php
   Route::post('/weight-logs/import', [WeightLogController::class, 'import'])->name('weight-logs.import');
   ```

2. **Controller Method**: Make sure your `import` method in the `WeightLogController` is set up to handle the file and process it.

### Debugging

- If the issue persists, check the Network tab in your browser's developer tools to see the request being made to your Laravel application. Ensure the file is being included in the request payload.
- Check Laravel's log files for any server-side errors.

By making these adjustments, your Vue component should correctly send the file to your Laravel application, where it can be processed according to your `import` method in the `WeightLogController`.


<template>
   <div>
      <div class="px-4 py-6">

  
      <div class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1 class="text-base font-semibold leading-6 text-gray-900">Body Tracking </h1>
        <p class="mt-2 text-sm text-gray-700">The table below shows your weight and body composition changes for each day you've logged them.</p>
      </div>
      <div class="mt-4 sm:ml-16 space-y-2 sm:mt-0 sm:flex-none">
        <button @click="newEntry()" type="button" class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Add Entry</button>
        <button @click="importForm()"
        
        type="button" class="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Import
        </button>
    </div>
    </div>
   
          <table class="min-w-full divide-y divide-gray-300">
              
            <thead>
              <tr>
                <th scope="col" class="whitespace-nowrap py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">Date</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">Weight</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">BF %</th>
                <th scope="col" class="whitespace-nowrap px-2 py-3.5 text-left text-sm font-semibold text-gray-900">Method</th>
               
                <th scope="col" class="relative whitespace-nowrap py-3.5 pl-3 pr-4 sm:pr-0">
                  <span class="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white">
              <tr v-for="log in weightLogs" :key="log.id">
               
                <td class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900">{{ log.log_date }}</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm text-gray-900">{{ log.weight }} lbs</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm text-gray-500">{{ log.body_fat_percentage }}%</td>
                <td class="whitespace-nowrap px-2 py-2 text-sm font-medium text-gray-900">{{ log.measurement_method }}</td>
               <td class="relative whitespace-nowrap py-2 pl-3 pr-4 text-right text-sm font-medium sm:pr-0">
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
                   <form @submit.prevent="submitNewEntry" class="mt-6 space-y-6">
         
             <!-- Weight Input -->
             <div>
                  <InputLabel for="weight" value="Weight" />
                  <TextInput id="weight" v-model="form.weight" type="number" class="mt-1 block w-full" placeholder="Enter weight in lbs" />
                  <InputError :message="form.errors.weight" class="mt-2" />
              </div>

              <!-- Body Fat Percentage Input -->
              <div>
                  <InputLabel for="body_fat_percentage" value="Body Fat Percentage" />
                  <TextInput id="body_fat_percentage" v-model="form.body_fat_percentage" type="number" class="mt-1 block w-full" placeholder="Enter body fat percentage" />
                  <InputError :message="form.errors.body_fat_percentage" class="mt-2" />
              </div>
              <div>
                  <InputLabel for="measurement_method" value="Measurement Method" />
                  <select id="measurement_method" v-model="form.measurement_method" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50">
                      <option disabled value="">Please select one</option>
                      <option value="calipers">Calipers</option>
                      <option value="scale">Scale</option>
                      <option value="dexa">DEXA</option>
                      <option value="visual_estimation">Visual Estimation</option>
                  </select>
                  <InputError :message="form.errors.measurement_method" class="mt-2" />
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
                  <SecondaryButton @click="closeModal"> Cancel </SecondaryButton>

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
              <h2 class="text-lg font-medium text-gray-900">
                 Import existing weight logs
                 <span v-if="importing" class="text-sm text-gray-500">Import in progress</span>
              </h2>

              <p class="mt-1 text-sm text-gray-600">
                Import a CSV file of your weight logs.
              </p>

          <div class="mt-6">
                  <InputLabel for="Weight" value="Weight" class="sr-only" />
                  <input type="file" @change="handleFileChange" />


                   <form @submit.prevent="importCSV" class="mt-6 space-y-6">
         
             <!-- Weight Input -->
             <!-- <div>
                  <InputLabel for="weight" value="Weight" />
                  <TextInput id="weight" v-model="form.weight" type="number" class="mt-1 block w-full" placeholder="Enter weight in lbs" />
                  <InputError :message="form.errors.weight" class="mt-2" />
              </div> -->

              <!-- Body Fat Percentage Input -->
              <!-- <div>
                  <InputLabel for="body_fat_percentage" value="Body Fat Percentage" />
                  <TextInput id="body_fat_percentage" v-model="form.body_fat_percentage" type="number" class="mt-1 block w-full" placeholder="Enter body fat percentage" />
                  <InputError :message="form.errors.body_fat_percentage" class="mt-2" />
              </div>
              <div>
                  <InputLabel for="measurement_method" value="Measurement Method" />
                  <select id="measurement_method" v-model="form.measurement_method" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50">
                      <option disabled value="">Please select one</option>
                      <option value="calipers">Calipers</option>
                      <option value="scale">Scale</option>
                      <option value="dexa">DEXA</option>
                      <option value="visual_estimation">Visual Estimation</option>
                  </select>
                  <InputError :message="form.errors.measurement_method" class="mt-2" />
              </div> -->
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
                  <SecondaryButton @click="closeModal"> Cancel </SecondaryButton>

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
import { ref } from 'vue';
import Modal from '@/Components/Modal.vue';
import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout.vue';
import InputLabel from '@/Components/InputLabel.vue';
import TextInput from '@/Components/TextInput.vue';
import InputError from '@/Components/InputError.vue';
import { useForm } from '@inertiajs/vue3';
import { usePage } from '@inertiajs/vue3';
import SecondaryButton from '@/Components/SecondaryButton.vue';
import PrimaryButton from '@/Components/PrimaryButton.vue';

const newEntryModal = ref(false);
const showImportModal = ref(false);
const form = useForm({
  weight: '',
  body_fat_percentage: '',
  measurement_method: '',
  //set log_date to today's date
  log_date: new Date().toISOString().slice(0, 10),
  //set log_time to current time
  log_time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }),

  //set user_id to current user
  user_id: usePage().props.auth.user.id,

});

const importForm = () => {
 
  showImportModal.value = true;
};



const createEntry = () => {
  form.post(route('weight-logs.store'));
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
  importing.value = true;
  if (!selectedFile.value) {
    alert('Please select a file to import.');
    return;
    
  }

  let formData = new FormData();
  formData.append('file', selectedFile.value);

  form.post(route('weight-logs.import'), formData, {
    onSuccess: () => {
      alert('File imported successfully.');
      importing.value = false;
      showImportModal.value = false;
    },
    onError: (errors) => {
      importing.value = false;
      console.error(errors);
    }
  });
};





</script>

when i click import nothing seems to happen. i do see a request in console though. but the modal is staying open and i cant tell if the file is being sent


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_laravel-vue-inertia-data-display-part1]]
- [[chatgpt/chatgpt_laravel-vue-inertia-data-display-part3]]
- [[chatgpt/chatgpt_importing-renpho-csv-data-part2]]
- [[chatgpt/chatgpt_log-weight-bf-data-part2]]
- [[chatgpt/chatgpt_scrape-ios-app-data-part2]]
