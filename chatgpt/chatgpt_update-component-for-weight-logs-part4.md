
on the profile update page, if the height or gender are already set, theyre not displaying any values when you refresh the page.  the data saves but the inputs on the form dont reflect it.

<script setup>
import InputError from '@/Components/InputError.vue';
import InputLabel from '@/Components/InputLabel.vue';
import PrimaryButton from '@/Components/PrimaryButton.vue';
import TextInput from '@/Components/TextInput.vue';
import { Link, useForm, usePage } from '@inertiajs/vue3';
import { computed, defineProps, reactive } from 'vue';

defineProps({
    mustVerifyEmail: {
        type: Boolean,
    },
    status: {
        type: String,
    },
});

const user = usePage().props.auth.user;
const heightInput = reactive({
    // ... other form fields ...
    heightFeet: null,
    heightInches: null
});


// Function to calculate combined height in centimeters
function calculateHeightInCm(feet, inches) {
    return (feet * 30.48) + (inches * 2.54);
}

// Function to handle form submission
const submitForm = () => {
    // Check if both feet and inches have values
    if (heightInput.heightFeet != null && heightInput.heightInches != null) {
        // Calculate the height in centimeters
        form.height = calculateHeightInCm(heightInput.heightFeet, heightInput.heightInches);
    } else {
        // Handle the case where height is not fully specified
        // This could be setting a default value, showing an error, etc.
        console.error("Height is not fully specified");
        return;
    }

    // Submit the form
    form.patch(route('profile.update'), {
        preserveScroll: true,
        onSuccess: () => console.log('Profile updated successfully')
    });
};


const form = useForm({
    name: user.name,
    email: user.email,
    gender: user.gender,
    age: user.age,
    height: null, // Initial value set to null
});

console.log(form);
</script>

<template>
    <section>
        <header>
            <h2 class="text-lg font-medium text-gray-900">Profile Information</h2>

            <p class="mt-1 text-sm text-gray-600">
                Update your account's profile information and email address.
            </p>
        </header>

        <form @submit.prevent="submitForm()" class="mt-6 space-y-6">
            <div>
                <InputLabel for="name" value="Name" />

                <TextInput
                    id="name"
                    type="text"
                    class="mt-1 block w-full"
                    v-model="form.name"
                    required
                    autofocus
                    autocomplete="name"
                />

                <InputError class="mt-2" :message="form.errors.name" />
            </div>

            <div>
                <InputLabel for="email" value="Email" />

                <TextInput
                    id="email"
                    type="email"
                    class="mt-1 block w-full"
                    v-model="form.email"
                    required
                    autocomplete="username"
                />

                <InputError class="mt-2" :message="form.errors.email" />
            </div>
            <div>
                <InputLabel for="gender" value="Gender" />

        
<select id="gender"  class="border-gray-300 focus:border-indigo-500 focus:ring-indigo-500 rounded-md shadow-sm" v-model="form.gender" required>
    <option value="Male">Male</option>
    <option value="Female">Female</option>
</select>

                <InputError class="mt-2" :message="form.errors.gender" />
            </div>
            <div>
                <InputLabel for="age" value="Age" />

                <TextInput id="age"
                type="number"
                class="mt-1 block w-full"
                v-model="form.age"
                required
                />

                <InputError class="mt-2" :message="form.errors.age" />
            </div>
            <InputLabel for="heightFeet" value="Height (Feet)" />
            <div class="flex gap-4 ">

                <div class="">
   

    <select id="heightFeet"  v-model="heightInput.heightFeet"  class="border-gray-300 focus:border-indigo-500 focus:ring-indigo-500 rounded-md shadow-sm">
        <option v-for="foot in 8" :key="foot" :value="foot">{{ foot }} ft</option>
    </select>
</div>
<div>
   

    <select id="heightInches" v-model="heightInput.heightInches"  class="border-gray-300 focus:border-indigo-500 focus:ring-indigo-500 rounded-md shadow-sm">
        <option v-for="inch in 11" :key="inch" :value="inch">{{ inch }} in</option>
    </select>
</div>

   
</div>
<InputError class="mt-2" :message="form.errors.height" />

            <div v-if="mustVerifyEmail && user.email_verified_at === null">
                <p class="text-sm mt-2 text-gray-800">
                    Your email address is unverified.
                    <Link
                        :href="route('verification.send')"
                        method="post"
                        as="button"
                        class="underline text-sm text-gray-600 hover:text-gray-900 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                        Click here to re-send the verification email.
                    </Link>
                </p>

                <div
                    v-show="status === 'verification-link-sent'"
                    class="mt-2 font-medium text-sm text-green-600"
                >
                    A new verification link has been sent to your email address.
                </div>
            </div>

            <div class="flex items-center gap-4">
                <PrimaryButton :disabled="form.processing">Save</PrimaryButton>

                <Transition
                    enter-active-class="transition ease-in-out"
                    enter-from-class="opacity-0"
                    leave-active-class="transition ease-in-out"
                    leave-to-class="opacity-0"
                >
                    <p v-if="form.recentlySuccessful" class="text-sm text-gray-600">Saved.</p>
                </Transition>
            </div>
        </form>
    </section>
</template>



The issue of the height and gender fields not displaying their values when you refresh the page is likely due to how you are initializing these fields in your Vue component. When the page loads, you need to populate these fields with the existing user data.

### Setting Up Initial Values

1. **Initialize Gender**: Since you are binding the gender dropdown to `form.gender`, make sure it's initialized with the user's gender.

2. **Initialize Height**: For the height, you need to convert the stored height value back into feet and inches and then initialize `heightInput.heightFeet` and `heightInput.heightInches` accordingly.

Here's an example of how you can do this:

```javascript
const user = usePage().props.auth.user;

// Convert centimeters back to feet and inches
function convertCmToFeetInches(cm) {
    const totalInches = cm / 2.54;
    const feet = Math.floor(totalInches / 12);
    const inches = Math.round(totalInches % 12);
    return { feet, inches };
}

// Assuming user.height is in centimeters
const userHeight = convertCmToFeetInches(user.height);

const heightInput = reactive({
    heightFeet: userHeight.feet,
    heightInches: userHeight.inches
});

const form = useForm({
    name: user.name,
    email: user.email,
    gender: user.gender,
    age: user.age,
    height: null, // This will be calculated during form submission
});
```

### Handling the Form Submission

When the form is submitted, you'll need to ensure the height is correctly calculated in centimeters as you did before:

```javascript
const submitForm = () => {
    // Rest of the code
};
```

### Update the Template

Ensure that the template correctly binds the `heightFeet` and `heightInches` dropdowns to `heightInput`:

```html
<select id="heightFeet" v-model="heightInput.heightFeet" ...>
    <!-- Options -->
</select>
<select id="heightInches" v-model="heightInput.heightInches" ...>
    <!-- Options -->
</select>
```

### Considerations

- Ensure that the user's height is being sent correctly from the backend in centimeters.
- You might need to adjust the `convertCmToFeetInches` function depending on how the height data is stored and the desired level of accuracy.

With these changes, the profile update form should correctly display the user's current height and gender when the page is refreshed.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
