
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
use Illuminate\Support\Facades\Log;


class WeightLogController extends Controller
{
    // Method to display the form for logging weight
    public function create()
    {
        return Inertia::render('WeightLog/Create'); // This should match the Vue component's file path
    }

    // Method to display the form for importing data
    function normalizeColumnName($name)
    {
        // Remove BOM from the start of the string
        $bom = pack('H*', 'EFBBBF');
        $name = preg_replace("/^$bom/", '', $name);

        // Remove other non-visible characters, trim whitespace, and convert to lowercase
        return strtolower(trim(preg_replace('/[\x00-\x1F\x7F\xA0\xAD]/u', '', $name)));
    }


    function findClosestMatch($needle, $haystack)
    {
        $needle = $this->normalizeColumnName($needle);
        $closest = null;
        $shortest = -1;
        $regexPatterns = [
            '/bf/', '/bodyfat/', '/body fat/', '/body_fat/'
        ];

        foreach ($haystack as $word) {
            // First, check for regex patterns
            foreach ($regexPatterns as $pattern) {
                if (preg_match($pattern, $this->normalizeColumnName($word))) {
                    return $word; // Return the word if it matches the pattern
                }
            }

            // Fallback to levenshtein if no regex match found
            $lev = levenshtein($needle, $this->normalizeColumnName($word));
            if ($lev == 0) {
                // Exact match
                $closest = $word;
                break;
            }
            if ($lev <= $shortest || $shortest < 0) {
                // Closer match
                $closest = $word;
                $shortest = $lev;
            }
        }
        return $closest;
    }


    // Method to import existing weight data from a CSV file
    /*  public function import(Request $request)
    {
        if (!$request->hasFile('csvFile')) {
            return response()->json(['error' => 'No file uploaded'], 400);
        }

        $request->validate(['csvFile' => 'required|file|mimes:csv,txt|max:2048']);

        // Read and process the CSV file
        $path = $request->file('csvFile')->getRealPath();
        $fileData = file($path);
        $data = array_map('str_getcsv', $fileData);
        $header = array_shift($data);

        // Normalize and find matched column names
        $normalizedHeaders = array_map([$this, 'normalizeColumnName'], $header);
        $matchedWeight = $this->findClosestMatch('Weight', $normalizedHeaders);
        $matchedBodyFat = $this->findClosestMatch('Body Fat Percentage', $normalizedHeaders);
        $matchedTime = $this->findClosestMatch('Time of Measurement', $normalizedHeaders);

        $userId = auth()->id();
        $fileName = $request->file('csvFile')->getClientOriginalName();
        $measurementMethod = str_contains($fileName, 'renpho') ? 'scale' : (str_contains($fileName, 'dexa') ? 'dexa' : 'unknown');

        try {
            foreach ($data as $row) {
                $rowData = array_combine($header, $row);

                if (isset($rowData[$matchedTime])) {
                    $dateTime = new \DateTime($rowData[$matchedTime]);
                    $logDate = $dateTime->format('Y-m-d');
                    $logTime = $dateTime->format('H:i:s');

                    WeightLog::updateOrCreate(
                        [
                            'user_id' => $userId,
                            'log_date' => $logDate,
                        ],
                        [
                            'weight' => isset($rowData[$matchedWeight]) ? $rowData[$matchedWeight] : null,
                            'body_fat_percentage' => isset($rowData[$matchedBodyFat]) ? $rowData[$matchedBodyFat] : null,
                            'measurement_method' => $measurementMethod,
                            'log_time' => $logTime,
                        ]
                    );
                }
            }
        } catch (\Exception $e) {
            Log::error('Error during import: ' . $e->getMessage());
            return response()->json(['error' => 'Import failed due to an error: ' . $e->getMessage()], 500);
        }

        return response()->json(['success' => 'Data imported successfully'], 200);
    } */

    public function import(Request $request)
    {
        if (!$request->hasFile('csvFile')) {
            Log::error('No file uploaded');
            return response()->json(['error' => 'No file uploaded'], 400);
        }

        $bom = pack('H*', 'EFBBBF');

        $request->validate(['csvFile' => 'required|file|mimes:csv,txt|max:2048']);

        // Read the CSV file
        $path = $request->file('csvFile')->getRealPath();
        $fileData = file($path);
        $data = array_map('str_getcsv', file($path));
        $header = array_shift($data);

        Log::info('CSV Header: ' . json_encode($header));

        // Normalize and find matched column names
        $normalizedHeaders = array_map([$this, 'normalizeColumnName'], $header);
        Log::info('Normalized Headers: ' . json_encode($normalizedHeaders));

        $matchedWeight = $this->findClosestMatch('Weight', $normalizedHeaders);
        $matchedBodyFat = $this->findClosestMatch('Body Fat Percentage', $normalizedHeaders);
        $matchedTime = $this->findClosestMatch('Time of Measurement', $normalizedHeaders);

        Log::info("Matched Weight: $matchedWeight, Matched Body Fat: $matchedBodyFat, Matched Time: $matchedTime");

        $userId = auth()->id();
        $fileName = strtolower($request->file('csvFile')->getClientOriginalName());
        $measurementMethod = 'unknown'; // Default value

        if (str_contains($fileName, 'renpho') || str_contains($fileName, 'scale')) {
            $measurementMethod = 'scale';
        } elseif (str_contains($fileName, 'dexa')) {
            $measurementMethod = 'dexa';
        }

        try {
            foreach ($data as $row) {
                // Combine the headers with the row data
                $rowData = array_combine($header, $row);

                // Remove BOM from each key in the row data and normalize to lowercase
                $rowData = array_combine(
                    array_map(function ($key) use ($bom) {
                        $keyWithoutBom = preg_replace("/^$bom/", '', $key);
                        return strtolower($keyWithoutBom); // Convert to lowercase
                    }, array_keys($rowData)),
                    array_values($rowData)
                );

                Log::info('Processed Row Data: ' . json_encode($rowData));


                if (isset($rowData[$matchedTime])) {
                    $dateTime = new \DateTime($rowData[$matchedTime]);
                    $logDate = $dateTime->format('Y-m-d');
                    $logTime = $dateTime->format('H:i:s');

                    // Check if weight is a valid number. Skip the row if it's not.
                    if (!isset($rowData[$matchedWeight]) || !is_numeric($rowData[$matchedWeight])) {
                        Log::info('Skipping row due to invalid or missing weight data: ' . json_encode($rowData));
                        continue; // Skip this iteration and move to the next row
                    }

                    // Since we're now sure weight is valid and present, we can proceed
                    $weight = $rowData[$matchedWeight];
                    $bodyFatPercentage = isset($rowData[$matchedBodyFat]) && is_numeric($rowData[$matchedBodyFat]) ? $rowData[$matchedBodyFat] : null;

                    $result = WeightLog::updateOrCreate(
                        [
                            'user_id' => $userId,
                            'log_date' => $logDate,
                        ],
                        [
                            'weight' => isset($rowData[$matchedWeight]) && is_numeric($rowData[$matchedWeight]) ? $rowData[$matchedWeight] : null,
                            'body_fat_percentage' => $bodyFatPercentage,
                            'measurement_method' => $measurementMethod,
                            'log_time' => $logTime,
                        ]
                    );

                    if ($result) {
                        Log::info('Data inserted/updated successfully for row');
                    } else {
                        Log::error('Failed to insert/update data for row');
                    }
                } else {

                    Log::error("Required key does not exist. Expected: $matchedTime, $matchedWeight, $matchedBodyFat. Row data: " . json_encode($rowData));
                }
            }
        } catch (\Exception $e) {
            Log::error('Error during import: ' . $e->getMessage());
            return response()->json(['error' => 'Import failed due to an error: ' . $e->getMessage()], 500);
        }

        return response()->json(['success' => 'Data imported successfully'], 200);
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



The code for your `WeightLogController` seems logically structured, but there might still be an issue with how the data from the CSV file is being processed and matched, particularly regarding the weight and body fat percentage.

Let's focus on these parts of the `import` function to ensure correct data extraction:

1. **Matching the Correct Columns**: Ensure that `$matchedWeight` and `$matchedBodyFat` are being matched with the correct columns. Given your use of regular expressions and the `levenshtein` function in `findClosestMatch`, you're on the right track, but ensure the patterns cover all the possible variations of the body fat percentage column you mentioned (like `bf`, `BF`, `bf%`, `BF(%)`, `BodyFat`, `Body Fat Percentage`, etc.).

2. **Column Data Extraction**: When extracting data for weight and body fat percentage, use the matched column names and validate the data.

```php
foreach ($data as $row) {
    // ...

    $rowData = array_combine(
        array_map(function ($key) use ($bom) {
            // Normalize key names
            $keyWithoutBom = preg_replace("/^$bom/", '', $key);
            return strtolower($keyWithoutBom);
        }, array_keys($row)),
        array_values($row)
    );

    // ...

    if (isset($rowData[$matchedTime])) {
        // ...

        // Validate weight data
        if (!isset($rowData[$matchedWeight]) || !is_numeric($rowData[$matchedWeight])) {
            Log::info('Skipping row due to invalid or missing weight data: ' . json_encode($rowData));
            continue; // Skip this row
        }

        // Validate body fat percentage data
        $bodyFatPercentage = isset($rowData[$matchedBodyFat]) && is_numeric($rowData[$matchedBodyFat]) ? $rowData[$matchedBodyFat] : null;

        $result = WeightLog::updateOrCreate(
            // ...
        );

        // ...
    } else {
        // Log error for missing key
    }
}
```

Ensure that the `$matchedWeight` and `$matchedBodyFat` variables are being correctly set based on the normalized column names. The `levenshtein` function can sometimes lead to incorrect matches if there are column names that are very similar. You might need to add additional checks or fine-tune your regex patterns to ensure accurate matches.

After implementing these changes, thoroughly test your import function with various CSV files to ensure it correctly identifies and imports the weight and body fat percentage data.


same result


If you're still getting the same result where the weight data is identical to the body fat data, it's likely that there's a mix-up in how you're referencing the columns from the CSV file in your `import` method. To resolve this, let's break down the steps and make sure each part is functioning as intended.

### 1. Verify Column Matching
First, ensure that the `$matchedWeight` and `$matchedBodyFat` variables correctly correspond to the respective columns in your CSV file. The `findClosestMatch` function should accurately identify the headers for weight and body fat percentage.

### 2. Check Data Extraction
Next, make sure that when extracting data for each row, you are correctly using `$matchedWeight` for the weight and `$matchedBodyFat` for the body fat percentage. There might be a mix-up here that causes the wrong data to be used.

### Updated Import Function

```php
public function import(Request $request)
{
    // ... existing code for file validation and header normalization ...

    $matchedWeight = $this->findClosestMatch('Weight', $normalizedHeaders);
    $matchedBodyFat = $this->findClosestMatch('Body Fat', $normalizedHeaders); // Adjusted for a more general match
    $matchedTime = $this->findClosestMatch('Time of Measurement', $normalizedHeaders);

    // ... existing code for setting measurement method ...

    foreach ($data as $row) {
        // Normalize and remove BOM from each key in the row data
        $rowData = array_combine(
            array_map(/* ... your existing normalization and BOM removal logic ... */, array_keys($row)),
            array_values($row)
        );

        if (isset($rowData[$matchedTime])) {
            // Validate and assign weight and body fat percentage
            $weight = isset($rowData[$matchedWeight]) && is_numeric($rowData[$matchedWeight]) ? $rowData[$matchedWeight] : null;
            if ($weight === null) {
                Log::info('Skipping row due to invalid or missing weight data');
                continue; // Skip rows with invalid or missing weight data
            }

            $bodyFatPercentage = isset($rowData[$matchedBodyFat]) && is_numeric($rowData[$matchedBodyFat]) ? $rowData[$matchedBodyFat] : null;

            // Update or create the record
            $result = WeightLog::updateOrCreate(
                /* ... */
            );

            // ... logging the results ...
        } else {
            Log::error("Required key does not exist. Row data: " . json_encode($rowData));
        }
    }

    return response()->json(['success' => 'Data imported successfully'], 200);
}
```

### Recommendations

- **Check CSV File**: Open the CSV file and verify the column headers for weight and body fat percentage. Make sure they match what you expect.
- **Debugging**: Log the `$matchedWeight` and `$matchedBodyFat` values right after they are set to ensure they match the correct columns.
- **Test with Simple Data**: Try a simple test CSV file with very clear and distinct column names to see if the issue persists.

This approach ensures that you're using the correct data for each field. If the issue still occurs, it might be helpful to log the contents of `$rowData` just before the `updateOrCreate` call to see exactly what data is being processed.


can we use open ai to match the columns?


Using OpenAI's models directly for matching CSV column names to specific fields like "weight" and "body fat percentage" in a Laravel application is not straightforward. OpenAI's models, including the one you're interacting with right now, are designed to generate responses to text inputs and don't directly interact with files or databases. However, you can apply principles from AI and machine learning to improve your column matching logic in PHP.

Here's an approach that combines pattern matching and fuzzy logic, which are principles used in AI, to improve your column name matching:

1. **Use Regular Expressions for Pattern Matching**: You've already started this with your regex patterns. Expand these patterns to cover more variations of the column names.

2. **Apply Fuzzy Logic for Matching**: Instead of relying solely on `levenshtein`, consider using a more comprehensive fuzzy matching technique. There are PHP libraries available that can perform more advanced string similarity checks than `levenshtein`.

3. **Combine Exact and Fuzzy Matching**: Use regex for exact pattern matching first. If no match is found, use fuzzy logic as a fallback.

Here is a revised snippet of your import function incorporating these ideas:

```php
// Import fuzzy matching library
use FuzzyWuzzy\Fuzz;

// ...

function findClosestMatch($needle, $haystack)
{
    $needle = $this->normalizeColumnName($needle);
    $closest = null;
    $maxScore = 0; // Fuzzy logic score

    // Regex patterns for exact matching
    $regexPatterns = [
        'weight' => '/weight|wt/',
        'body fat' => '/bf|bodyfat|body fat|body_fat/'
    ];

    foreach ($haystack as $word) {
        $normalizedWord = $this->normalizeColumnName($word);

        // Check regex patterns first
        if (isset($regexPatterns[$needle]) && preg_match($regexPatterns[$needle], $normalizedWord)) {
            return $word;
        }

        // Fuzzy logic matching as a fallback
        $score = Fuzz::ratio($needle, $normalizedWord);
        if ($score > $maxScore) {
            $maxScore = $score;
            $closest = $word;
        }
    }

    return $closest;
}

// ...

```

In this example, `Fuzz::ratio` is a hypothetical method from a fuzzy matching library. You would need to find and include a suitable library in your Laravel application to use this functionality. A popular choice for such operations in PHP is the `fuzzywuzzy` library, or you can look for other similar libraries that provide fuzzy string matching.

By applying this improved matching logic, your application will be more robust in identifying the correct columns from varied CSV headers. Remember to test thoroughly with different header variations to ensure the logic works as expected.


Class "FuzzyWuzzy\Fuzz" not found


The error "Class 'FuzzyWuzzy\Fuzz' not found" indicates that the PHP environment does not recognize the `FuzzyWuzzy\Fuzz` class. This can happen if the class or library you are trying to use is not installed or properly included in your project. 

The `FuzzyWuzzy\Fuzz` class was used as a hypothetical example to illustrate the concept of using a fuzzy matching library. However, if you want to implement fuzzy matching in PHP, you would typically need to use a real library that provides such functionality. Unfortunately, as of my last update, there is no direct PHP port of Python's "FuzzyWuzzy" library.

But you can use alternative libraries or approaches for fuzzy string matching in PHP. Here are a few steps you can take:

### 1. Find a Suitable PHP Library for Fuzzy Matching

You can search for PHP libraries that offer fuzzy string matching. For instance, one common approach is to use the `similar_text` PHP function, which calculates the similarity between two strings.

### 2. Use PHP's Built-In Functions

PHP offers some built-in functions that can be used for similar purposes, such as `similar_text` or `levenshtein`. Here’s an example using `similar_text`:

```php
function findClosestMatch($needle, $haystack) {
    $needle = $this->normalizeColumnName($needle);
    $closest = null;
    $highestPercent = 0;

    foreach ($haystack as $word) {
        similar_text($needle, $this->normalizeColumnName($word), $percent);
        if ($percent > $highestPercent) {
            $highestPercent = $percent;
            $closest = $word;
        }
    }

    return $closest;
}
```

### 3. Install and Use Composer Packages

If you prefer to use an external library, you might need to install it via Composer, PHP's package manager. Look for packages like `jenssegers/agent` or other string comparison libraries, and install them using Composer.

```bash
composer require jenssegers/agent
```

After installing, you can use the library's methods in your Laravel application.

### 4. Update Your Import Function

Whichever method you choose, update your import function accordingly to use the fuzzy matching for finding the closest header matches.

### 5. Test Thoroughly

After implementing the changes, test your function with various CSV files to ensure that the header matching works as expected, especially for different possible variations of the column names.

### Conclusion

Switch to using PHP's built-in string comparison functions if you do not have a specific library installed for fuzzy matching. These built-in functions should suffice for basic needs of fuzzy matching in most cases. If you require more advanced string comparison features, consider installing a suitable library via Composer.



{"error":"Import failed due to an error: Undefined variable $logDate"}


The error "Undefined variable $logDate" suggests that the `$logDate` variable is being used in your `import` function before it's defined, or it's not being set in the scope where it's needed. This usually occurs if the variable is either not declared at all or is only declared inside a conditional block and then used outside of it.

To resolve this, ensure that `$logDate` is correctly defined and set before it's used in your `updateOrCreate` method. The `$logDate` variable should typically be set after you've validated that the necessary data exists in the current row being processed.

Here's a revised snippet of your import function, focusing on the `$logDate` assignment:

```php
public function import(Request $request)
{
    // ... previous code ...

    foreach ($data as $row) {
        // ... normalization and BOM removal logic ...

        if (isset($rowData[$matchedTime])) {
            $dateTime = new \DateTime($rowData[$matchedTime]);
            $logDate = $dateTime->format('Y-m-d'); // Set logDate based on matchedTime
            $logTime = $dateTime->format('H:i:s');

            // ... check for weight and body fat percentage ...

            $result = WeightLog::updateOrCreate(
                [
                    'user_id' => $userId,
                    'log_date' => $logDate, // Use logDate here
                    // ... other fields ...
                ],
                [
                    'weight' => $weight,
                    'body_fat_percentage' => $bodyFatPercentage,
                    'measurement_method' => $measurementMethod,
                    'log_time' => $logTime,
                    // ... other fields ...
                ]
            );

            // ... handling the result ...
        } else {
            Log::error("Required key does not exist. Expected: $matchedTime, $matchedWeight, $matchedBodyFat. Row data: " . json_encode($rowData));
            continue; // Skip this row if the required key does not exist
        }
    }

    return response()->json(['success' => 'Data imported successfully'], 200);
}
```

In this revised version, `$logDate` is set within the `if (isset($rowData[$matchedTime]))` block, ensuring that it's only used after it's been properly defined. The `continue` statement is used to skip rows that do not have the required time data, thus avoiding any attempt to use an undefined `$logDate`.

Make sure to test your updated function thoroughly to confirm that the issue is resolved and that the data is being processed correctly.


## See Also
- [[chatgpt/chatgpt_importing-renpho-csv-data-part1]]
- [[chatgpt/chatgpt_importing-renpho-csv-data-part2]]
- [[chatgpt/chatgpt_importing-renpho-csv-data-part3]]
- [[chatgpt/chatgpt_scrape-ios-app-data-part4]]
- [[chatgpt/chatgpt_artist-data-via-api]]
