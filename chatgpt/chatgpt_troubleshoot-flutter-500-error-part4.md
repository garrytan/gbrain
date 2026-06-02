
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


ok on the home page we are im getting 0 for weight and 0 for bf right now


It looks like you're encountering a problem where the weight and body fat percentage are showing up as 0. This could be due to several reasons, such as:

1. **Data Not Fetched**: The `_fetchHealthData` method might not be fetching data correctly.
2. **Initial State Not Set**: The initial state for `_latestWeight` and `_bodyFatPercentage` might not be set based on the data fetched.
3. **UI Not Updating**: The UI might not be updating even if the data is fetched correctly.

To debug and resolve this:

1. **Check Data Fetching**:
   Verify that your `_fetchHealthData` method is fetching the data correctly from the health plugin and that you have permissions to read the data.

2. **Set Initial State**:
   Make sure that after fetching the data, you are setting the state correctly. For example:
   ```dart
   setState(() {
     _latestWeight = fetchedWeight; // Set the fetched weight
     _bodyFatPercentage = fetchedBodyFatPercentage; // Set the fetched body fat percentage
   });
   ```

3. **Ensure Proper State Management**:
   Verify that you are managing the state of `_latestWeight` and `_bodyFatPercentage` properly. If the data is fetched asynchronously, you need to ensure that `setState` is called to update the UI.

Here's a revised version of the relevant part of your `_MyHomePageState` class with added debug prints and comments for clarity:

```dart
Future<void> _fetchHealthData() async {
  DateTime endDate = DateTime.now();
  List<double> weeklyStepsTemp = [];
  double fetchedWeight = 0.0;
  double fetchedBodyFatPercentage = 0.0;
  
  // ... Rest of your variables

  HealthFactory health = HealthFactory();

  // ... Rest of your types

  bool accessGranted = await health.requestAuthorization(types);

  if (accessGranted) {
    try {
      // Fetch steps data as before
      // ...

      // Fetch the latest weight
      List<HealthDataPoint> weightData = await health.getHealthDataFromTypes(
          endDate.subtract(Duration(days: 1)), endDate, [HealthDataType.WEIGHT]);
      fetchedWeight = weightData.isNotEmpty ? weightData.first.value : 0.0;

      // Fetch the latest body fat percentage
      List<HealthDataPoint> bodyFatData = await health.getHealthDataFromTypes(
          endDate.subtract(Duration(days: 1)), endDate, [HealthDataType.BODY_FAT_PERCENTAGE]);
      fetchedBodyFatPercentage = bodyFatData.isNotEmpty ? bodyFatData.first.value : 0.0;

      // Debug prints to ensure that data is fetched
      print('Fetched weight: $fetchedWeight');
      print('Fetched body fat percentage: $fetchedBodyFatPercentage');

      setState(() {
        _latestWeight = fetchedWeight;
        _bodyFatPercentage = fetchedBodyFatPercentage;
        // ... Set other state variables
      });
    } catch (e) {
      print('An error occurred while fetching health data: $e');
    }
  } else {
    print("Health data access not granted");
  }
}
```

Make sure that the `health.getHealthDataFromTypes` method is called correctly and that it's fetching the latest data point. You might need to adjust the time range to ensure that it captures the most recent data.

If you continue to receive zeros, ensure that there is data available for the given date range and that you have permission to access it. The Health plugin may require specific permissions to be granted by the user, and different data types can have different permission requirements.

You might also want to review the error handling in the health data fetching to ensure any exceptions are caught and handled properly.


ok lets do this.

In our server we currently store the users weight and body fat percentage and the date for each entry.  This way we can display their weight and bf over time as it changes.

We want to create a new controller for this data to be both requested and saved to the server from the app. We'll put this controller in our API folder.

Then in the flutter app we want to change our code so that 2 things happen:
1) We have a new function that fetches our weight logs data and puts it in the local store for us to display on the home screen as well as other location in the app. This will get retriggered on the homescreen when we refresh the screen by pulling to refresh.
2) When we open the app on the phone, it grabs our new entries from the apple health kit and saves them to our server, then triggers our request so we can update our store with those new values.

The end goal is to track a users weight and BF, with our flutter app and web app having the same data, while the user logs the data elsewhere on their phone via health kit.


To achieve this, you will need to do the following:

1. **Create a new controller on the server** to handle fetching and saving weight and body fat percentage logs.

2. **Update the Flutter app** to interact with this new controller.

Here's a high-level overview of what each part might look like:

### Server-Side (Laravel API)

1. **Create a new controller** named `WeightLogsController`.

2. **Define routes** in your `api.php` file for fetching and saving weight logs.

3. **Implement methods** in `WeightLogsController` for saving new logs and fetching existing logs.

Example of a Laravel Controller Method:
```php
public function store(Request $request)
{
    $request->validate([
        'weight' => 'required|numeric',
        'body_fat_percentage' => 'required|numeric',
        'date' => 'required|date',
    ]);

    $log = new WeightLog([
        'user_id' => $request->user()->id,
        'weight' => $request->weight,
        'body_fat_percentage' => $request->body_fat_percentage,
        'date' => $request->date,
    ]);

    $log->save();

    return response()->json($log, 201);
}

public function index(Request $request)
{
    $logs = $request->user()->weightLogs()->get();

    return response()->json($logs);
}
```

### Flutter App-Side

1. **Fetch and save data** from HealthKit.

2. **Create a service** in Flutter to handle API calls to your Laravel server.

3. **Implement a pull-to-refresh** on the home screen to fetch the latest logs.

4. **Save new HealthKit entries** to the server upon app launch.

Example of a Flutter Service Method:
```dart
class WeightLogsService {
  final String apiUrl = 'https://yourserver.com/api/weight_logs';
  final storage = FlutterSecureStorage();

  Future<List<WeightLog>> getWeightLogs() async {
    final token = await storage.read(key: 'authToken');
    final response = await http.get(Uri.parse(apiUrl), headers: {
      'Authorization': 'Bearer $token',
    });

    if (response.statusCode == 200) {
      List<dynamic> body = jsonDecode(response.body);
      List<WeightLog> logs = body
          .map((dynamic item) => WeightLog.fromJson(item))
          .toList();
      return logs;
    } else {
      // Handle the case where the logs couldn't be fetched
      throw Exception('Failed to load weight logs');
    }
  }

  Future<void> saveWeightLog(WeightLog log) async {
    final token = await storage.read(key: 'authToken');
    final response = await http.post(Uri.parse(apiUrl),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json',
        },
        body: jsonEncode(log.toJson()));

    if (response.statusCode == 201) {
      // Successfully saved the log
    } else {
      // Handle the case where the log couldn't be saved
      throw Exception('Failed to save weight log');
    }
  }
}
```

You would need to create a `WeightLog` model in Flutter that has a `toJson` method for encoding the data and a corresponding `fromJson` method for decoding the data.

Additionally, in your home screen's `initState`, you would call a method to fetch the latest HealthKit data and then save it to your server. After saving, you would fetch the logs from your server to update the local store.

For the pull-to-refresh feature, you could use a `RefreshIndicator` that calls `getWeightLogs` when triggered.

Please note that the code examples above are quite simplistic and assume the existence of certain classes and methods like `WeightLog.fromJson` and `toJson`. You'll need to flesh them out based on your actual data models and API specifications.


Creating a new controller for handling weight and body fat percentage data involves both server-side and client-side development. Here's how you can approach the solution:

### Server-Side: Laravel API Controller

1. **Create a new controller in Laravel**:
   
   ```bash
   php artisan make:controller Api/HealthMetricsController
   ```

2. **Define routes in `routes/api.php`**:
   
   ```php
   Route::middleware('auth:api')->group(function () {
       Route::get('/health-metrics', 'Api\HealthMetricsController@index');
       Route::post('/health-metrics', 'Api\HealthMetricsController@store');
   });
   ```

3. **Implement the controller methods**:

   ```php
   <?php

   namespace App\Http\Controllers\Api;

   use App\Http\Controllers\Controller;
   use App\Models\HealthMetric;
   use Illuminate\Http\Request;
   use Illuminate\Support\Facades\Auth;

   class HealthMetricsController extends Controller
   {
       public function index()
       {
           $user = Auth::user();
           return response()->json($user->healthMetrics()->orderBy('date', 'desc')->get());
       }

       public function store(Request $request)
       {
           $request->validate([
               'weight' => 'required|numeric',
               'body_fat_percentage' => 'required|numeric',
               'date' => 'required|date',
           ]);

           $user = Auth::user();
           $metric = $user->healthMetrics()->create($request->all());

           return response()->json($metric, 201);
       }
   }
   ```

4. **Create a `HealthMetric` model if not already created**:

   ```bash
   php artisan make:model HealthMetric -m
   ```

5. **Set up the migration**:

   ```php
   public function up()
   {
       Schema::create('health_metrics', function (Blueprint $table) {
           $table->id();
           $table->foreignId('user_id')->constrained()->onDelete('cascade');
           $table->double('weight');
           $table->double('body_fat_percentage');
           $table->date('date');
           $table->timestamps();
       });
   }
   ```

6. **Run the migration**:

   ```bash
   php artisan migrate
   ```

7. **Create relationships in the `User` model**:

   ```php
   public function healthMetrics()
   {
       return $this->hasMany(HealthMetric::class);
   }
   ```

### Flutter App: Fetching and Posting Data

1. **Fetching health metrics**:

   ```dart
   Future<void> fetchHealthMetrics() async {
     final storage = FlutterSecureStorage();
     final String? token = await storage.read(key: 'authToken');
     final uri = Uri.parse('https://yourapi.com/api/health-metrics');

     final response = await http.get(uri, headers: {
       'Authorization': 'Bearer $token',
     });

     if (response.statusCode == 200) {
       final data = jsonDecode(response.body);
       // Store data locally, e.g., using Provider or another state management solution
     } else {
       // Handle errors
     }
   }
   ```

2. **Saving health metrics**:

   ```dart
   Future<void> saveHealthMetrics(double weight, double bodyFatPercentage) async {
     final storage = FlutterSecureStorage();
     final String? token = await storage.read(key: 'authToken');
     final uri = Uri.parse('https://yourapi.com/api/health-metrics');

     final response = await http.post(
       uri,
       headers: {
         'Content-Type': 'application/json',
         'Authorization': 'Bearer $token',
       },
       body: jsonEncode({
         'weight': weight,
         'body_fat_percentage': bodyFatPercentage,
         'date': DateTime.now().toIso8601String(),
       }),
     );

     if (response.statusCode == 201) {
       // Upon success, fetch metrics to update local store
       fetchHealthMetrics();
     } else {
       // Handle errors
     }
   }
   ```

3. **Trigger fetching data on the home screen refresh**:

   Modify your `RefreshIndicator` onRefresh callback to call `fetchHealthMetrics`.

4. **Trigger saving data when opening the app**:

   In the `initState` of your home screen, after fetching new data from Apple Health Kit, call `saveHealthMetrics`.

### Final Integration

The integration of these functionalities will allow your Flutter app to synchronize health data with your server, keeping the user's weight and body fat percentage consistent across different platforms and devices. Remember to handle user authentication and data privacy appropriately, as health data is sensitive.

This solution assumes that you have proper authentication and user relationship setup on your server, and that your Flutter app is equipped with the necessary packages for making HTTP requests and handling JSON data. Adjust the UR


i made a controller

<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\HealthMetric;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class HealthMetricsController extends Controller
{
    public function index()
    {
        $user = Auth::user();
        return response()->json($user->healthMetrics()->orderBy('date', 'desc')->get());
    }

    public function store(Request $request)
    {
        $request->validate([
            'weight' => 'required|numeric',
            'body_fat_percentage' => 'required|numeric',
            'date' => 'required|date',
        ]);

        $user = Auth::user();
        $metric = $user->healthMetrics()->create($request->all());

        return response()->json($metric, 201);
    }
}
 

But i also want to store steps for the user as well. 


To store steps for the user along with the weight and body fat percentage, you can make the following adjustments:

### 1. Database Schema Update:
First, you need to ensure that your `health_metrics` table in the database can store steps. If it doesn't already have a column for steps, you'll need to add one. You can do this by creating a new migration:

```bash
php artisan make:migration add_steps_to_health_metrics_table --table=health_metrics
```

In the migration file, you can then add:

```php
public function up()
{
    Schema::table('health_metrics', function (Blueprint $table) {
        $table->integer('steps')->nullable(); // Using integer to store step count
    });
}

public function down()
{
    Schema::table('health_metrics', function (Blueprint $table) {
        $table->dropColumn('steps');
    });
}
```

Run the migration with `php artisan migrate`.

### 2. Controller Adjustment:
You'll need to adjust your `HealthMetricsController` to accept steps as part of the request, validate it, and store it.

Update your `store` method in `HealthMetricsController`:

```php
public function store(Request $request)
{
    $request->validate([
        'weight' => 'required|numeric',
        'body_fat_percentage' => 'required|numeric',
        'date' => 'required|date',
        'steps' => 'sometimes|numeric', // 'sometimes' means the field is not required
    ]);

    $user = Auth::user();
    $metric = $user->healthMetrics()->create([
        'weight' => $request->weight,
        'body_fat_percentage' => $request->body_fat_percentage,
        'date' => $request->date,
        'steps' => $request->steps, // Save steps
    ]);

    return response()->json($metric, 201);
}
```

### 3. Adjusting the Model:
Ensure that your `HealthMetric` model has the `steps` attribute listed in its `$fillable` array so that it can be mass-assigned:

```php
protected $fillable = ['weight', 'body_fat_percentage', 'date', 'steps'];
```

### 4. Updating Flutter App:
On the Flutter side, you'll need to make sure that your requests to store health metrics include the step count when you call your API. Update the `saveWeightLog` method in your `WeightLogsService` to include steps:

```dart
Future<void> saveWeightLog(WeightLog log) async {
    final token = await storage.read(key: 'authToken');
    final response = await http.post(Uri.parse(apiUrl),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'weight': log.weight,
          'body_fat_percentage': log.bodyFatPercentage,
          'date': log.date.toIso8601String(),
          'steps': log.steps, // Include steps
        }));

    // ... handle the response
}
```

Make sure the `WeightLog` class in your Flutter app has a `steps` field and includes it in its `toJson` method.

This way, your server-side and client-side applications will be aligned to handle step counts along with other health metrics. Always ensure that when you're making changes involving data, you're also considering validation and proper handling of the data to maintain data integrity and security.


is my model right


<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class HealthMetric extends Model
{
    use HasFactory;
    protected $fillable = ['weight', 'body_fat_percentage', 'date', 'steps'];
}



Yes, your `HealthMetric` model looks good. It correctly utilizes the `fillable` property to define which fields can be mass-assigned when creating or updating a model instance. Here's a breakdown of your model:

- `namespace App\Models;` - Correctly namespaced.
- `use Illuminate\Database\Eloquent\Factories\HasFactory;` - This is good if you're planning to use factories for seeding your database during development.
- `use Illuminate\Database\Eloquent\Model;` - Correct inheritance from the base Eloquent model.
- `protected $fillable = ['weight', 'body_fat_percentage', 'date', 'steps'];` - This line allows these columns to be mass-assignable, which is what you want for your application.

Just ensure that your database migration matches these fields and that your controller correctly interacts with this model. You might also want to consider adding validation, both on the server side (in your controller) and on the client side (in your Flutter app) to ensure the data integrity.

Additionally, if you are going to use date operations or comparisons, you might want to cast the `date` field to a Carbon instance for more convenient handling:

```php
protected $casts = [
    'date' => 'datetime',
];
```

This cast allows you to use a multitude of date comparison and manipulation methods provided by the Carbon library, which is included by default in Laravel. It can make working with dates much easier. 

And, if there are any relationships with other models (like a `User` model), don't forget to define those relationships in the `HealthMetric` model. For example:

```php
public function user()
{
    return $this->belongsTo(User::class);
}
```

This assumes each health metric belongs to a user and you have a `user_id` column in your `health_metrics` table. This is not strictly necessary for what you've described so far, but it's a common pattern in applications dealing with user data.


how about my controller:


<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\HealthMetric;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class HealthMetricsController extends Controller
{
    public function index()
    {
        $user = Auth::user();
        return response()->json($user->healthMetrics()->orderBy('date', 'desc')->get());
    }

    public function store(Request $request)
    {
        $request->validate([
            'weight' => 'required|numeric',
            'body_fat_percentage' => 'required|numeric',
            'date' => 'required|date',
            'steps' => 'sometimes|numeric', // 'sometimes' means the field is not required
        ]);

        $user = Auth::user();
        $metric = $user->healthMetrics()->create([
            'weight' => $request->weight,
            'body_fat_percentage' => $request->body_fat_percentage,
            'date' => $request->date,
            'steps' => $request->steps, // Save steps
        ]);

        return response()->json($metric, 201);
    }
}


(the healthMetrics() has a red line under it as if not working


Your `HealthMetricsController` looks mostly correct. The problem you're encountering with `healthMetrics()` not being recognized likely stems from the absence of a corresponding relationship method in your `User` model. The controller expects a `healthMetrics` relationship method in your `User` model to fetch or create health metrics associated with a user.

Here's how you can solve this:

1. **Define the Relationship in the User Model:**
   
   In your `User` model (`App\Models\User`), you should define a relationship to `HealthMetric`. If you haven't done this already, add the following method to the `User` model:

    ```php
    public function healthMetrics()
    {
        return $this->hasMany(HealthMetric::class);
    }
    ```

    This method establishes a one-to-many relationship between a user and their health metrics. It assumes that your `health_metrics` table has a `user_id` foreign key column to relate each health metric to a specific user.

2. **Correct API Resource Response (Optional):**

    In your `HealthMetricsController`, you are directly returning Eloquent collections as JSON. This is fine for simple APIs, but for more complex or larger applications, you might want to use API Resources for better attribute handling and transformation.

    For now, your approach is okay, but consider using [API Resources](https://laravel.com/docs/8.x/eloquent-resources) in the future for more control over the JSON structure your API returns.

3. **Proper Validation:**

    Your validation in the `store` method looks good. It ensures that the incoming request has the necessary fields and that they are of the correct type. The use of `'sometimes|numeric'` for `steps` is appropriate if the `steps` field is optional.

4. **Error Handling:**

    Consider adding error handling in your controller methods. While Laravel will handle validation errors automatically, any errors during the creation of a health metric will result in a server error (HTTP 500). You might want to wrap your creation logic in a try-catch block and return a proper error response if something goes wrong.

    ```php
    try {
        // Your logic to create a health metric
    } catch (\Exception $e) {
        return response()->json(['message' => 'Failed to create health metric', 'error' => $e->getMessage()], 500);
    }
    ```

If you've added the `healthMetrics` method to your `User` model and you're still seeing an issue, ensure there are no typos, and the relationship is defined correctly. If the problem persists, it might be beneficial to clear your config cache using `php artisan config:clear` and ensure your models are correctly autoloaded.


Here is my HealthMetric model:
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class HealthMetric extends Model
{
    use HasFactory;


    protected $fillable = ['weight', 'body_fat_percentage', 'date', 'steps'];

    protected $casts = [
        'date' => 'datetime',
    ];


    public function user()
    {
        return $this->belongsTo(User::class);
    }
}

Here is my user model:
<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name', 'email', 'password', 'height', 'age', 'gender',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * The attributes that should be cast.
     *
     * @var array<string, string>
     */
    protected $casts = [

        'email_verified_at' => 'datetime',
        'age' => 'integer',
    ];

    /**
     * Get the weight logs for the user.
     */
    public function weightLogs()
    {
        return $this->hasMany(WeightLog::class);
    }

    public function healthMetrics()
    {
        return $this->hasMany(HealthMetric::class);
    }

    /*  public function setHeightAttribute($value)
{
    // Assuming the height is provided in the format 'feet'inches"
    // For example, "5'11" for 5 feet 11 inches
    list($feet, $inches) = explode("'", $value);

    // Convert feet to meters and inches to meters
    $feetToMeters = $feet * 0.3048;
    $inchesToMeters = $inches * 0.0254;

    // Sum the conversions and store in the database
    $this->attributes['height'] = $feetToMeters + $inchesToMeters;
} */
}


Here is my controller:
<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\HealthMetric;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class HealthMetricsController extends Controller
{
    public function index()
    {
        $user = Auth::user();
        return response()->json($user->healthMetrics()->orderBy('date', 'desc')->get());
    }

    public function store(Request $request)
    {
        $request->validate([
            'weight' => 'required|numeric',
            'body_fat_percentage' => 'required|numeric',
            'date' => 'required|date',
            'steps' => 'sometimes|numeric', // 'sometimes' means the field is not required
        ]);

        $user = Auth::user();
        $metric = $user->healthMetrics()->create([
            'weight' => $request->weight,
            'body_fat_percentage' => $request->body_fat_percentage,
            'date' => $request->date,
            'steps' => $request->steps, // Save steps
        ]);

        return response()->json($metric, 201);
    }
}



**Topic:** [[chatgpt-clusters/coding_mobile]]
