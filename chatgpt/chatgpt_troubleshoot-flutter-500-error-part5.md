
Your setup looks good. The `HealthMetric` model is correctly linked to the `User` model through the `healthMetrics` relationship. Your `HealthMetricsController` is properly set up to fetch and store health metrics. Here's a review and some suggestions:

### Review:

1. **Models**:
    - `HealthMetric` Model: It has a `user` method that correctly sets up a reverse relationship to the `User` model.
    - `User` Model: It has a `healthMetrics` method that correctly sets up a relationship to the `HealthMetric` model.

2. **Controller**:
    - `index` Method: It fetches the logged-in user's health metrics and returns them in descending order by date.
    - `store` Method: It validates the incoming request, creates a new `HealthMetric` instance related to the logged-in user, and returns the newly created instance.

### Suggestions:

1. **Validation**:
    - Consider adding more specific validation rules if necessary. For example, you might want to ensure that `body_fat_percentage` is between 0 and 100.

2. **Error Handling**:
    - In the `store` method, consider adding a try-catch block to handle any unexpected errors that may occur when creating a new `HealthMetric`.

3. **API Resources**:
    - As your API grows, you may want to use [API Resources](https://laravel.com/docs/8.x/eloquent-resources) to transform your models into JSON. API Resources allow you to format and manipulate the JSON response of your models more elegantly.

4. **Data Representation**:
    - For better user experience, consider how you want to represent the `date`, `weight`, `body_fat_percentage`, and `steps`. For instance, you might want to convert the `weight` to a specific unit (kg or lbs) based on the user's preference.

5. **Front-end Implementation**:
    - In your Flutter app, make sure to handle the token authentication correctly when making requests to the `HealthMetricsController`.
    - Implement error handling in your Flutter service methods to gracefully handle situations where the network request fails.

6. **Securing Routes**:
    - Ensure that your routes are protected and that only authenticated users can access the `index` and `store` methods of the `HealthMetricsController`. Laravel Sanctum does a great job at this if set up correctly.

7. **Timestamps in HealthMetric Model**:
    - If you want to keep track of when each health metric was created or updated, ensure that your `health_metrics` table has `created_at` and `updated_at` columns, and that your `HealthMetric` model doesn't set `$timestamps` to `false`.

By following these suggestions, you'll have a robust backend setup for managing health metrics in your application.


Undefined method 'healthMetrics'.intelephense(P1013)


The error message `Undefined method 'healthMetrics'.intelephense(P1013)` typically occurs when the Intelephense extension in your code editor (likely Visual Studio Code) does not recognize the method. This can happen for several reasons, but it doesn't necessarily mean your code is incorrect. It could be due to the editor's static analysis not fully understanding dynamic methods in Laravel (like those created via relationships).

Here's how you can address the issue:

### 1. Ensure the Relationship is Correctly Defined
Make sure your `User` model correctly defines the `healthMetrics` relationship. It should look something like this:

```php
// User.php

public function healthMetrics()
{
    return $this->hasMany(HealthMetric::class);
}
```

### 2. Clear Cache
Sometimes the editor or Laravel caches could cause such issues. You can try clearing the cache:

```bash
php artisan config:clear
php artisan cache:clear
```

### 3. Reload Intelephense
In Visual Studio Code, you can command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and type "Reload" to find the "Developer: Reload Window" command. This will reload VS Code and often resolves Intelephense issues.

### 4. Install Laravel IDE Helper (Optional)
[Laravel IDE Helper](https://github.com/barryvdh/laravel-ide-helper) generates a file that your IDE understands, making it recognize Laravel's facades and magic methods, which can help with auto-completion and navigation.

You can install it via composer and generate the helper file:

```bash
composer require --dev barryvdh/laravel-ide-helper
php artisan ide-helper:generate
```

This tool is beneficial for developers using Laravel with PHPStorm or VS Code with Intelephense.

### 5. Manual DocBlocks (Optional)
As a last resort, or if you prefer not to use the Laravel IDE Helper, you can manually add a DocBlock above your class definition to inform your IDE about the magic methods being used. Here's how you can do it for your `User` model:

```php
/**
 * @property \Illuminate\Database\Eloquent\Collection|\App\Models\HealthMetric[] $healthMetrics
 */
class User extends Authenticatable
{
    // ... existing code
}
```

This tells your IDE that `$user->healthMetrics` is an instance of `Illuminate\Database\Eloquent\Collection` containing `HealthMetric` models.

Remember, while these steps might suppress the warning in your IDE, they're primarily cosmetic and for developer convenience. If your code is working as expected, this issue likely won't affect your runtime PHP code.


ok now lets test our new health metric controller with post man


To test your new `HealthMetric` controller with Postman, follow these steps:

1. **Start Your Laravel Server**:
    - If it's not already running, start your Laravel server by running `php artisan serve` in your terminal. This will typically host your application at `http://localhost:8000`.

2. **Open Postman**:
    - Launch Postman.

3. **Set Up Authentication (if required)**:
    - If your API routes are protected by authentication, you'll need a valid token to test them.
    - You can obtain a token by first using Postman to log in through your login route and then using the token from the response in your HealthMetric requests.
    - Set the `Authorization` header to `Bearer <your_token>` in Postman.

4. **Test the `index` Method (GET request)**:
    - Set the HTTP method to `GET`.
    - Enter the URL for the `index` method of your `HealthMetric` controller (e.g., `http://localhost:8000/api/health_metrics`).
    - Send the request and you should see a list of health metrics for the authenticated user.

5. **Test the `store` Method (POST request)**:
    - Set the HTTP method to `POST`.
    - Enter the URL for the `store` method of your `HealthMetric` controller (e.g., `http://localhost:8000/api/health_metrics`).
    - In the Body section of Postman, choose `raw` and `JSON (application/json)`.
    - Enter the data you want to store. For example:
        ```json
        {
            "weight": 70.5,
            "body_fat_percentage": 15.3,
            "date": "2023-01-29",
            "steps": 5000
        }
        ```
    - Send the request.
    - If everything is set up correctly, you should see the newly created `HealthMetric` in the response.

6. **Check for Errors**:
    - If you encounter any errors, check the response message for clues about what went wrong.
    - Common issues include validation errors (make sure you're sending all required fields in the correct format) and authentication issues (make sure your token is correct and has the necessary permissions).

Remember, testing with Postman is a great way to ensure your API endpoints work as expected before integrating them into your front-end application. It helps catch any issues early in the development process.


  "message": "Target class [Api\\HealthMetricsController] does not exist.",
    "exception": "Illuminate\\Contracts\\Container\\BindingResolutionException",
    "file": "/var/task/vendor/laravel/framework/src/Illuminate/Container/Container.php",
    "line": 914,
    "trace": [


The error message `"Target class [Api\HealthMetricsController] does not exist."` indicates that Laravel cannot locate the `HealthMetricsController` class. This issue often arises due to namespace mismatches, incorrect file paths, or missing definitions in the routes configuration. Here's how to troubleshoot and resolve the problem:

### 1. Check Namespace and Class Name
Ensure that the namespace and class name in your `HealthMetricsController` file match what you've used in your routes. Based on your controller code, it should look like this:

```php
// File path: app/Http/Controllers/Api/HealthMetricsController.php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
// ... other use statements

class HealthMetricsController extends Controller {
    // ... controller methods
}
```

### 2. Check the Routes Configuration
Make sure your routes are correctly pointing to the controller. If you're using a route group with a prefix for API routes, it might look something like this in your `routes/api.php` file:

```php
// routes/api.php

use App\Http\Controllers\Api\HealthMetricsController;

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/health_metrics', [HealthMetricsController::class, 'index']);
    Route::post('/health_metrics', [HealthMetricsController::class, 'store']);
});
```

Ensure that the namespace for the controller matches the namespace declared in the controller file.

### 3. Autoload the Classes
Sometimes, the class might not be correctly autoloaded. You can regenerate the autoload files by running:

```bash
composer dump-autoload
```

### 4. Clear Caches
Laravel caches some configuration data. Try clearing these caches using the following commands:

```bash
php artisan config:clear
php artisan route:clear
php artisan cache:clear
```

### 5. Check File and Class Names
Ensure that the file name matches the class name and follows the PSR-4 autoloading standard. For instance, if your class is named `HealthMetricsController`, the file name should be `HealthMetricsController.php`.

### 6. Inspect the Error Log
The stack trace in the error log can provide more information about where the issue is occurring. Check the files and lines referenced in the trace for clues.

By following these steps, you should be able to resolve the `"Target class does not exist"` error and get your `HealthMetricsController` working correctly. If the problem persists, double-check all file paths, namespaces, and class names for typos or inconsistencies.


ok now its working when i do a postman request


That's great to hear! Now that your `HealthMetricsController` is working as expected when you make a request with Postman, you've successfully set up the server-side part of your application to handle health metrics.

The next steps are to ensure your Flutter app interacts correctly with these endpoints. You should:

1. **Implement or Update the Service in Flutter**: 
    - Ensure you have a service in your Flutter app to make HTTP requests to these endpoints.
    - The service should handle token authentication, make GET requests to fetch health metrics, and POST requests to submit new health metrics.

2. **Integrate with HealthKit**:
    - On the app launch or at a specific trigger point, fetch the required data from HealthKit.
    - After fetching data from HealthKit, send it to your server using the POST endpoint you've tested with Postman.

3. **Handle Pull-to-Refresh on Home Screen**:
    - Implement a pull-to-refresh mechanism on the home screen that triggers a fetch from your `/api/health_metrics` endpoint.
    - Ensure the UI updates to display the latest data after fetching.

4. **Error Handling and User Feedback**:
    - Implement proper error handling in your Flutter app. If a network request fails or something goes wrong, ensure that your app gracefully handles the situation and provides appropriate feedback to the user.

5. **Testing**:
    - Test the entire flow from fetching data from HealthKit, sending it to your server, fetching it back on the home screen, and ensuring that the data is correctly displayed.
    - Test how your app behaves with no data, with partial data, and with complete data to ensure a good user experience in all cases.

6. **Security Considerations**:
    - Ensure that your API is secure and that only authenticated users can access their health metrics.
    - Validate all incoming data on the server-side to ensure it meets your expectations and doesn't introduce any security vulnerabilities.

By carefully implementing and testing these steps, you'll create a robust system that keeps your Flutter app and web app synchronized with the user's health data, providing a seamless experience for the user.


okay so now lets add the flutter app service


To create a service in your Flutter app for interacting with the `HealthMetricsController` on your server, follow these steps:

### 1. Create a HealthMetricsService

First, create a new file for the service, for example, `health_metrics_service.dart`. In this file, you'll define methods for fetching and posting health metrics data.

```dart
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:your_app_name/models/health_metric.dart'; // Import your HealthMetric model

class HealthMetricsService {
  final String baseUrl = 'https://yourserver.com/api'; // Replace with your actual server URL
  final storage = FlutterSecureStorage();

  Future<List<HealthMetric>> fetchHealthMetrics() async {
    final token = await storage.read(key: 'authToken');
    final response = await http.get(
      Uri.parse('$baseUrl/health_metrics'),
      headers: {
        'Authorization': 'Bearer $token',
      },
    );

    if (response.statusCode == 200) {
      Iterable list = json.decode(response.body);
      return list.map((model) => HealthMetric.fromJson(model)).toList();
    } else {
      // Handle the case where the logs couldn't be fetched
      throw Exception('Failed to load health metrics');
    }
  }

  Future<void> saveHealthMetric(HealthMetric healthMetric) async {
    final token = await storage.read(key: 'authToken');
    final response = await http.post(
      Uri.parse('$baseUrl/health_metrics'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode(healthMetric.toJson()),
    );

    if (response.statusCode != 201) {
      // Handle the case where the log couldn't be saved
      throw Exception('Failed to save health metric');
    }
  }
}
```

In this service:

- `fetchHealthMetrics` method fetches all health metrics for the authenticated user.
- `saveHealthMetric` method saves a new health metric to the server.
- `baseUrl` should be replaced with the actual URL of your server.
- `HealthMetric` is a model class that you should define based on the structure of the health metrics data. It should have a `fromJson` method for parsing the response from the server and a `toJson` method for sending data to the server.

### 2. Define the HealthMetric Model

Create a `HealthMetric` model that matches the data structure of your health metrics. Here's a basic example:

```dart
class HealthMetric {
  final double weight;
  final double bodyFatPercentage;
  final DateTime date;
  final int steps;

  HealthMetric({this.weight, this.bodyFatPercentage, this.date, this.steps});

  factory HealthMetric.fromJson(Map<String, dynamic> json) {
    return HealthMetric(
      weight: json['weight'],
      bodyFatPercentage: json['body_fat_percentage'],
      date: DateTime.parse(json['date']),
      steps: json['steps'] ?? 0, // Assuming 'steps' could be null
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'weight': weight,
      'body_fat_percentage': bodyFatPercentage,
      'date': date.toIso8601String(),
      'steps': steps,
    };
  }
}
```

### 3. Use the Service in Your App

Now, you can use `HealthMetricsService` in your Flutter app to fetch and save health metrics:

- Call `fetchHealthMetrics` whenever you want to refresh the data, such as in a pull-to-refresh mechanism.
- Call `saveHealthMetric` whenever you want to send new data to the server, such as after fetching new data from HealthKit.

Remember to handle the `Future` responses properly, using `async` and `await`, and to provide user feedback, especially in cases where an exception is thrown (e.g., when the fetch or save operation fails). 

This service lays the foundation for synchronizing your Flutter app's health data with your server, providing a seamless integration between the user's HealthKit data and your application's backend.


The parameter 'bodyFatPercentage' can't have a value of 'null' because of its type, but the implicit default value is 'null'.
Try adding either an explicit non-'null' default value or the 'required' modifier.dartmissing_default_value_for_parameter


The error indicates that the `bodyFatPercentage` parameter in your `HealthMetric` constructor is non-nullable but does not have a default value nor is marked as required. This means that Dart expects a value to always be provided for this parameter.

You can solve this in two ways:

### 1. Make the parameter required

If `bodyFatPercentage` should always be provided when creating a `HealthMetric` object, you can mark it as required. This is the preferred way if the value is essential and should not be null.

```dart
class HealthMetric {
  final double weight;
  final double bodyFatPercentage;
  final DateTime date;
  final int steps;

  HealthMetric({
    required this.weight,
    required this.bodyFatPercentage,
    required this.date,
    this.steps = 0,
  });

  // ... (rest of your code)
}
```

With this approach, Dart forces you to provide a value for `bodyFatPercentage` whenever you instantiate a `HealthMetric` object.

### 2. Provide a default value

If it makes sense for `bodyFatPercentage` to have a default value (and you are sure that having a default won't cause issues in your logic), you can provide a default value like this:

```dart
class HealthMetric {
  final double weight;
  final double bodyFatPercentage;
  final DateTime date;
  final int steps;

  HealthMetric({
    this.weight = 0.0,
    this.bodyFatPercentage = 0.0, // Default value
    this.date,
    this.steps = 0,
  });

  // ... (rest of your code)
}
```

This approach sets `bodyFatPercentage` to `0.0` if no value is provided when the `HealthMetric` is instantiated. 

**Choose the method that best fits your application's logic.** If `bodyFatPercentage` is a crucial value and should always be provided explicitly, use the first method (`required`). If it's okay for `bodyFatPercentage` to be `0.0` by default when not provided, use the second method (default value).


ok now when the app loads we need to grab the data from health kit run the service


To grab data from HealthKit and then run the service to save it to your server when your Flutter app loads, you can follow these steps:

### 1. Request Permission and Fetch Data from HealthKit

First, ensure you have the necessary permissions to access the data from HealthKit. Then, fetch the relevant data (e.g., steps, weight, body fat percentage) when the app starts.

This can typically be done in the `initState` of your main widget or another appropriate location that gets called when your app starts.

Here's a rough structure of how you might do this:

```dart
import 'package:health/health.dart';

class _MyAppState extends State<MyApp> {
  HealthFactory health = HealthFactory();

  @override
  void initState() {
    super.initState();
    fetchDataFromHealthKit();
  }

  void fetchDataFromHealthKit() async {
    // Define the types of data to fetch
    List<HealthDataType> types = [
      HealthDataType.STEPS,
      HealthDataType.WEIGHT,
      HealthDataType.BODY_FAT_PERCENTAGE,
    ];

    // Request access to the data
    bool accessGranted = await health.requestAuthorization(types);

    if (accessGranted) {
      // Define the date range you want to fetch the data for
      DateTime startDate = DateTime.now().subtract(Duration(days: 30));
      DateTime endDate = DateTime.now();

      try {
        // Fetch the data
        List<HealthDataPoint> healthData = await health.getHealthDataFromTypes(startDate, endDate, types);
        HealthData healthDataModel = HealthData.fromHealthDataPoints(healthData);

        // Process and save the data using your service
        saveHealthData(healthDataModel);
      } catch (exception) {
        print(exception.toString());
      }
    }
  }

  void saveHealthData(HealthData healthData) async {
    // Use your HealthMetricsService to save the data
    final service = HealthMetricsService();
    
    // Assuming HealthMetric model has a constructor that accepts the HealthData fields
    final healthMetric = HealthMetric(
      weight: healthData.weight,
      bodyFatPercentage: healthData.bodyFatPercentage,
      steps: healthData.steps,
      date: DateTime.now(), // Use the current date or the appropriate date
    );

    try {
      await service.saveHealthMetric(healthMetric);
      print('Health data saved successfully');
    } catch (e) {
      print('Failed to save health data: $e');
    }
  }

  // ... rest of your widget code
}
```

### 2. Handle Background Fetch (Optional)

If you want to fetch and save data even when the app is not actively used, you might want to implement background fetching. This is more complex and platform-specific. For iOS, you can use the `background_fetch` package for Flutter, and for Android, you might use the `WorkManager`.

### Note

- Ensure you handle user permissions gracefully. Users might deny access to their health data, and your app should handle such scenarios without crashing.
- Remember to test this thoroughly, as dealing with HealthKit and background processes can be tricky and have many edge cases.
- Ensure that you are complying with all privacy and data handling requirements of both Apple (for HealthKit data) and the regions in which your app is available. This often involves properly informing the user about what data is used for and obtaining explicit consent.

The above example provides a basic structure. You'll need to adjust it to fit the specifics of your data and how you've set up your `HealthMetric` model and `HealthMetricsService`.


maybe we should wait til the user logs in?


Waiting until the user logs in before fetching and sending health data to the server is a good practice. It ensures that the data is associated with the correct user account and that your app respects user privacy and data security.

Here's how you can structure this:

### 1. Trigger Data Fetch on User Login

After a successful login, you can trigger the data fetching and sending process. This can be done in the part of your Flutter app where the login logic is handled. 

Assuming you have a login function, you could structure it like this:

```dart
Future<void> loginUser(String email, String password) async {
  // ... Your existing login logic

  // If login is successful
  if (loginSuccess) {
    // Fetch and send health data
    fetchDataFromHealthKit();
  }
}
```

### 2. Fetch Data from HealthKit

The `fetchDataFromHealthKit` function remains the same as in the previous response. It fetches the health data and sends it to your server.

### 3. Store Data on Server

After fetching the data, the `saveHealthData` function is called to send this data to your server. Ensure that the user's authentication token is used when sending the data so that it's associated with the correct user account.

### 4. Consider User Privacy

Before fetching health data, it might be a good practice to inform the user about what data you are accessing and why. Ensure you have the proper permissions and that the user has agreed to share this data with your app.

### 5. Handle Background Updates (Optional)

If you want the health data to be updated regularly, even when the user is not interacting with the app, consider implementing a background task to fetch and send this data. This will require additional setup and handling of background tasks specific to iOS and Android.

### Summary

By fetching and sending health data after user login, you ensure that:

1. The data is tied to the correct user account.
2. You respect user privacy by not accessing data before the user has logged in and consented to data sharing.
3. The data on your server remains current, as it's updated each time the user logs in.

This approach provides a balance between keeping health data up-to-date and respecting user privacy and data security.


heres my home.dart file

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/screens/login_page.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/screens/profile.dart';
import 'package:superheromobile/screens/settings_page.dart';
import 'package:superheromobile/screens/welcome.dart';
import '../algorithms.dart';
import 'package:superheromobile/utils.dart';
import 'package:superheromobile/components/MetricDisplayComponent.dart';
import 'package:superheromobile/screens/ProfileCompletionPage.dart';
import 'package:superheromobile/theme.dart';

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});

  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  int _selectedIndex = 0;
  int _stepCount = 0;
  double _latestWeight = 0.0;
  double _height = 0.0;
  double _bodyFatPercentage = 0.0;
  List<double> weeklySteps = [];
  List<DateTime> listOfDates = []; // Define the listOfDates variable

  int _calculateAge(DateTime birthday) {
    final currentDate = DateTime.now();
    int age = currentDate.year - birthday.year;
    if (birthday.month > currentDate.month ||
        (birthday.month == currentDate.month &&
            birthday.day > currentDate.day)) {
      age--;
    }
    return age;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkUserDetails());
    _fetchHealthData();
    _generateDatesList(); // Call this function in initState
  }

  void _checkUserDetails() async {
    final userModel = Provider.of<UserModel>(context, listen: false);
    if (userModel.currentUser != null) {
      bool detailsComplete = _areUserDetailsComplete(userModel.currentUser!);
      if (!detailsComplete) {
        // If details are not complete, redirect to the profile completion page
        await Navigator.of(context).pushAndRemoveUntil(
            MaterialPageRoute(builder: (context) => ProfileCompletionPage()),
            (Route<dynamic> route) => false);
        // After returning from profile completion, check details again
        _checkUserDetails();
      }
    }
  }

  bool _areUserDetailsComplete(User user) {
    // Add checks for required user details here
    // Return true if all required details are complete, otherwise false
    // For example:
    return user.name.isNotEmpty; // Add more required fields as necessary
  }

  // Function to populate listOfDates
  void _generateDatesList() {
    DateTime today = DateTime.now();
    for (int i = 6; i >= 0; i--) {
      listOfDates.add(today.subtract(Duration(days: i)));
    }
  }

  Future<void> _fetchHealthData() async {
    DateTime endDate = DateTime.now();
    List<double> weeklyStepsTemp = [];

    HealthFactory health = HealthFactory();

    List<HealthDataType> types = [
      HealthDataType.STEPS,
      HealthDataType.WEIGHT,
      HealthDataType.HEIGHT,
      HealthDataType.BODY_FAT_PERCENTAGE
    ];

    bool accessGranted = await health.requestAuthorization(types);

    if (accessGranted) {
      for (int i = 6; i >= 0; i--) {
        DateTime day = DateTime(endDate.year, endDate.month, endDate.day - i);

        List<HealthDataPoint> stepData = await health.getHealthDataFromTypes(
            day, day.add(Duration(days: 1)), [HealthDataType.STEPS]);
        int steps = stepData.fold<int>(0, (sum, item) {
          return sum + (item.value as NumericHealthValue).numericValue.toInt();
        });

        weeklyStepsTemp.add(steps.toDouble());
      }

      // Rest of your data fetching logic (for weight, body fat, height, etc.)

      setState(() {
        this.weeklySteps = weeklyStepsTemp;
        _latestWeight = _latestWeight;
        // Update other state variables like _stepCount, _latestWeight, etc.
      });
    } else {
      print("Health data access not granted");
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = context.watch<UserModel>();
    double age =
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;

    double bodyscore = calculateBodyScore(_bodyFatPercentage, 18);

    double ffmiCalculated = calculateFFMI(
        _latestWeight, user.currentUser?.height ?? 0.0, _bodyFatPercentage);

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Align(
          alignment: Alignment.centerLeft,
          child: Image.asset(
            'assets/img/logo_white.png', // Path to your logo image
            fit: BoxFit.contain, // You can adjust the fit as needed
            height: 14, // Height to match AppBar size
          ),
        ),
        actions: <Widget>[
          IconButton(
            icon: Icon(Icons.settings),
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => SettingsPage()),
              );
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        color: Colors.grey,

        //make the background color match the theme

        onRefresh: _fetchHealthData,
        child: Column(
          children: [
            // Display user's name
            Padding(
              padding: const EdgeInsets.all(8.0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  user.currentUser?.name ?? 'Name not set',
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(10.0), // Adjust padding as needed
              child: Column(
                mainAxisSize: MainAxisSize
                    .min, // To keep the column size just enough for its children
                mainAxisAlignment:
                    MainAxisAlignment.center, // Center the children vertically
                crossAxisAlignment: CrossAxisAlignment
                    .center, // Center the children horizontally
                children: [
                  MetricDisplayComponent(
                    metricName: 'Steps',
                    currentValue: weeklySteps
                        .last, // Assuming the last entry is the most recent day
                    goalValue: 12000, // Example goal value
                    isGraphMode: true, // Enable bar graph mode
                    graphData: weeklySteps, // Pass the weekly steps data
                    dates: listOfDates, // Pass the list of dates here
                  ),
                ],
              ),
            ),

            Expanded(
              child: GridView.count(
                crossAxisCount: 2, // Adjust the number of columns
                childAspectRatio: 1.3, // Adjust the aspect ratio
                children: <Widget>[
                  /*  _featuredStatCard('FFMI', ffmiCalculated, Colors.blue,
                      context), // Add this line */

                  Card(
                    color: Colors.black, // Slightly lighter than black
                    elevation: 8.0, // Adds shadow for elevation
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                          10), // Matches the borderRadius of MetricDisplayComponent
                    ),
                    child: MetricDisplayComponent(
                      metricName: 'Weight',
                      currentValue: _latestWeight,
                      units: 'kgs',
                      imperial: true,
                    ),
                  ),
                  /*  Card(
                    color: Colors.black, // Slightly lighter than black
                    elevation: 8.0, // Adds shadow for elevation
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                          10), // Matches the borderRadius of MetricDisplayComponent
                    ),
                    child: MetricDisplayComponent(
                      metricName: 'Height',
                      currentValue: user.currentUser?.height.toDouble() ?? 0.0,
                      units: 'centimeters',
                      imperial: true,
                    ),
                  ), */
                  Card(
                    color: Colors.black, // Slightly lighter than black
                    elevation: 8.0, // Adds shadow for elevation
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                          10), // Matches the borderRadius of MetricDisplayComponent
                    ),
                    child: MetricDisplayComponent(
                      metricName: 'Body Fat',
                      currentValue: _bodyFatPercentage,
                      units: 'percent',
                    ),
                  ),
                  /*  Card(
                    color: Colors.black, // Slightly lighter than black
                    elevation: 8.0, // Adds shadow for elevation
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                          10), // Matches the borderRadius of MetricDisplayComponent
                    ),
                    child: MetricDisplayComponent(
                      metricName: 'Age',
                      currentValue: user.currentUser?.age.toDouble() ?? 0.0,
                    ), 
                  ),*/
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: Colors.black,
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.home),
            label: 'Home',
          ),
          BottomNavigationBarItem(
              icon: Icon(Icons.account_circle), label: 'Profile'),
          BottomNavigationBarItem(
            icon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
        currentIndex: _selectedIndex,
        onTap: _onItemTapped,
      ),
    );
  }

  // New method to handle logout
  void _logout() async {
    final storage = FlutterSecureStorage();
    await storage.delete(key: 'authToken');
    // Redirect to the login page or update state to show logged out status
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (context) => LoginPage()),
    );
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });

    if (index == 1) {
      // Retrieve the user model using Provider
      // Retrieve the user model using Provider
      UserModel userModel = Provider.of<UserModel>(context, listen: false);
      Navigator.push(
        context,
        MaterialPageRoute(
          // Make sure to use the correct named parameter 'userModel' here
          builder: (context) => ProfilePage(userModel: userModel),
        ),
      );
    } else if (index == 2) {
      //go to the profilecompletion page
      Navigator.push(
        context,
        MaterialPageRoute(builder: (context) => ProfileCompletionPage()),
      );
    }
  }

  String _getFormattedValue(String label, double value, BuildContext context) {
    final userModel = Provider.of<UserModel>(context, listen: false);
    final isMetric = userModel.currentUser?.isMetric ??
        true; // Default to true if currentUser or isMetric is null // Default to true

    switch (label) {
      case 'Weight':
        return isMetric
            ? '${value.toStringAsFixed(2)} kg'
            : '${(value * 2.20462).toStringAsFixed(2)} lbs';
      case 'Height':
        if (isMetric) {
          return '${value.toStringAsFixed(0)} cm';
        } else {
          value = value * 0.03281; // Convert centimeters to feet
          int feet = value.floor();
          double inches = (value - feet) * 12;
          return '${feet}\' ${inches.toStringAsFixed(0)}"';
        }
      case 'Body Fat':
        return '${value.toStringAsFixed(2)}%';
      case 'Age': // Add this case for 'Age'
        return value.round().toString();
      default:
        return value.toStringAsFixed(2);
    }
  }

// ... Rest of your code
}





**Topic:** [[chatgpt-clusters/coding_mobile]]
