---
conversation_id: 1865d3b9-d75d-42ec-84ce-827183eae8c5
created: 2024-01-22
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Steps Graph in Flutter
type: essay
updated: 2024-01-22
---

# Steps Graph in Flutter

> Conversation ID: 1865d3b9-d75d-42ec-84ce-827183eae8c5
> Created: 2024-01-22T08:37:36Z
> Updated: 2024-01-22T08:47:57Z
> Messages: 6


here is our main.dart file
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/screens/login_page.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/screens/profile.dart';
import 'package:superheromobile/screens/settings_page.dart';
import 'package:superheromobile/screens/welcome.dart';
import 'algorithms.dart';
import 'models/auth.dart';
import 'theme.dart';
import 'package:superheromobile/screens/home.dart';
import 'package:superheromobile/utils.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final authModel = AuthModel();
  await authModel.checkLoggedIn();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (context) => UserModel()),
        ChangeNotifierProvider(create: (context) => AuthModel()),
        // ... other providers
      ],
      child: MyApp(),
    ),
  );
}

class MyApp extends StatelessWidget {
  ThemeData buildDarkTheme() {
    return ThemeData(
      brightness: Brightness.dark,
      // Add color to the progress indicator within the theme
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: Colors.white, // Set the color as needed
      ),

      // Define the rest of your dark theme properties here
    );
  }

  @override
  Widget build(BuildContext context) {
    final isLoggedIn = Provider.of<AuthModel>(context).isLoggedIn;

    return MaterialApp(
      title: 'A7X3',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      themeMode: ThemeMode
          .dark, // Always use the dark mode regardless of system preference.
      darkTheme: buildDarkTheme(), // Use the custom dark theme
      routes: {
        '/login': (context) => LoginPage(),
        '/welcome': (context) => WelcomeScreen(),
        '/settings': (context) => SettingsPage(),
        '/home': (context) => MyHomePage(title: 'A7X3'),
        '/welcome': (context) => WelcomeScreen(),
        // ... other routes
      },

      home: isLoggedIn ? MyHomePage(title: 'A7X3') : WelcomeScreen(),
    );
  }
}


here is our home.dart file

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

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});

  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  int _selectedIndex = 0; // Add this line to track the selected index
  int _stepCount = 0;
  double _latestWeight = 0.0;
  double _height = 0.0;
  double _bodyFatPercentage = 0.0; // Add this line

  int _age = 0; // Placeholder for age

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
    _fetchHealthData();
  }

  // Inside the _MyHomePageState class
  void _goToProfile() {
    // Assuming you have a BuildContext available as `context`
    UserModel userModel = Provider.of<UserModel>(context, listen: false);
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ProfilePage(userModel: userModel),
      ),
    );
  }

  Future<void> _fetchHealthData() async {
    DateTime endDate = DateTime.now();
    DateTime startDate = DateTime(endDate.year, endDate.month, endDate.day);
    DateTime heightStartDate = DateTime(endDate.year - 1, endDate.month,
        endDate.day); // Fetch height data from a year ago

    HealthFactory health = HealthFactory();

    // Request authorization for steps, weight, and height
    List<HealthDataType> types = [
      HealthDataType.STEPS,
      HealthDataType.WEIGHT,
      HealthDataType.HEIGHT,
      HealthDataType.BODY_FAT_PERCENTAGE // Ensure this is included
    ];
    bool accessGranted = await health.requestAuthorization(types);

    if (accessGranted) {
      try {
        // Fetch steps
        List<HealthDataPoint> stepData = await health
            .getHealthDataFromTypes(startDate, endDate, [HealthDataType.STEPS]);
        int steps = stepData.fold<int>(0, (sum, item) {
          if (item.value is NumericHealthValue) {
            NumericHealthValue numericValue = item.value as NumericHealthValue;
            return sum + numericValue.numericValue.toInt();
          } else {
            print("Unexpected value type for steps: ${item.value.runtimeType}");
            return sum;
          }
        });

        // Fetch the most recent weight entry
        List<HealthDataPoint> weightData = await health.getHealthDataFromTypes(
            startDate, endDate, [HealthDataType.WEIGHT]);
        double latestWeight = weightData.isNotEmpty
            ? ((weightData.last.value as NumericHealthValue)
                .numericValue
                .toDouble())
            : 0.0;

        // Fetch the most recent body fat percentage entry
        List<HealthDataPoint> bodyFatData = await health.getHealthDataFromTypes(
            startDate, endDate, [HealthDataType.BODY_FAT_PERCENTAGE]);
        double latestBodyFatPercentage = bodyFatData.isNotEmpty
            ? ((bodyFatData.last.value as NumericHealthValue)
                    .numericValue
                    .toDouble() *
                100) // Multiply by 100
            : 0.0;

        // Fetch the most recent height entry over a longer time span
        List<HealthDataPoint> heightData = await health.getHealthDataFromTypes(
            heightStartDate, endDate, [HealthDataType.HEIGHT]);
        double latestHeight = heightData.isNotEmpty
            ? ((heightData.last.value as NumericHealthValue)
                .numericValue
                .toDouble())
            : 0.0;

        // TODO: Fetch and calculate age based on the date of birth

        setState(() {
          _stepCount = steps;
          _latestWeight = latestWeight;
          _height = latestHeight; // Update height
          _bodyFatPercentage = latestBodyFatPercentage; // Add this line

          // Update age state as well (once age calculation is implemented)
        });
      } catch (error) {
        print("An error occurred fetching health data: $error");
      }
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
    List<double> weeklySteps = [3000, 4500, 3200, 5000, 2600, 4200, 3800];

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
                  user.currentUser?.name ?? 'Not logged in',
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
                  ),
                ],
              ),
            ),

            Card(
              color: Colors.black, // Slightly lighter than black
              elevation: 8.0, // Adds shadow for elevation
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                    10), // Matches the borderRadius of MetricDisplayComponent
              ),
              child: MetricDisplayComponent(
                metricName: 'Steps',
                currentValue: _stepCount.toDouble(),
                goalValue: 12000,
                isGraphMode: true,
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
                  Card(
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
                  ),
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
                  Card(
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
                  ),
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
    } else if (index == 2) {}
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


we need to get the steps for the past 7 days and pass that area to our steps widget so it can display a graph of the steps over the last 7 days

here is our metricdisplaycomponent.dart
import 'package:flutter/material.dart';
import 'package:superheromobile/components/BarGraphComponent.dart';

class MetricDisplayComponent extends StatelessWidget {
  final String metricName;
  final double currentValue;
  final int? goalValue;
  final String? units; // Now nullable, no unit displayed if null
  final bool? imperial; // Now nullable, defaults to false if null
  final bool isGraphMode; // New property to toggle graph mode
  final List<double>? graphData; // Data for the graph mode

  const MetricDisplayComponent({
    Key? key,
    required this.metricName,
    required this.currentValue,
    this.goalValue,
    this.units, // Not required, no unit will be shown if this is null
    this.imperial, // Not required, defaults to false
    this.isGraphMode = false,
    this.graphData,
  }) : super(key: key);

  String getDisplayValue(double value, String? units, bool? imperial) {
    if (units != null) {
      final bool isImperial = imperial ?? false;
      switch (units) {
        case 'centimeters':
          return isImperial
              ? '${(value / 30.48).floor()}′${((value / 2.54) % 12).toStringAsFixed(0)}″' // Convert cm to ft and in
              : '${value.toStringAsFixed(0)} cm';
        case 'feet':
          return isImperial
              ? '${value.floor()}′${(value % 1 * 12).toStringAsFixed(0)}″' // Assume value is already in feet
              : '${(value * 30.48).toStringAsFixed(0)} cm'; // Convert feet to cm
        case 'lbs':
          return isImperial
              ? '${value.toStringAsFixed(0)} lbs'
              : '${(value / 2.20462).toStringAsFixed(0)} kg';
        case 'kgs':
          return isImperial
              ? '${(value * 2.20462).toStringAsFixed(0)} lbs'
              : '${value.toStringAsFixed(0)} kg';
        case 'percent':
          return '${value.toStringAsFixed(0)}%'; // Percentages are the same in both systems
        default:
          return formatNumber(
              value); // Fallback to formatted number without units
      }
    } else {
      // If no units are provided, return the formatted number without units
      return formatNumber(value);
    }
  }

  String formatNumber(double value) {
    if (value >= 1000 && value < 1000000) {
      return (value / 1000).toStringAsFixed(1) + 'K';
    } else if (value >= 1000000 && value < 1000000000) {
      return (value / 1000000).toStringAsFixed(1) + 'M';
    } else if (value >= 1000000000) {
      return (value / 1000000000).toStringAsFixed(1) + 'B';
    } else {
      return value.toStringAsFixed(0);
    }
  }

/* 
  @override
  Widget build(BuildContext context) {
    double? progress =
        goalValue != null ? (currentValue / goalValue!).clamp(0.0, 1.0) : null;
    Color barColor =
        progress != null && progress < 1.0 ? Colors.blue : Colors.green;
    String displayValue = getDisplayValue(currentValue, units, imperial);
    // Conditionally display the bar graph or the progress bar
    if (isGraphMode && graphData != null) {
      return BarGraphComponent(dataValues: graphData!);
    } else {
      // ... existing single metric and progress bar UI

      return Container(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              metricName,
              style: TextStyle(color: Colors.white70, fontSize: 18),
            ),
            SizedBox(height: 8),
            Text(
              displayValue,
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 36,
                  fontWeight: FontWeight.bold),
            ),
            if (goalValue != null) ...[
              SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.all(Radius.circular(10)),
                child: LinearProgressIndicator(
                  value: progress,
                  backgroundColor: Colors.grey[800],
                  valueColor: AlwaysStoppedAnimation<Color>(barColor),
                  minHeight: 10,
                ),
              ),
              SizedBox(height: 8),
              Text(
                'Goal ${getDisplayValue(goalValue!.toDouble(), units, imperial)}',
                style: TextStyle(color: Colors.white70),
              ),
            ],
          ],
        ),
      );
    }
  }
}
 */
  @override
  Widget build(BuildContext context) {
    String displayValue = getDisplayValue(currentValue, units, imperial);
    double? progress =
        goalValue != null ? (currentValue / goalValue!).clamp(0.0, 1.0) : null;
    Color barColor =
        progress != null && progress < 1.0 ? Colors.blue : Colors.green;

    // Start building the widget
    return Container(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            metricName,
            style: TextStyle(color: Colors.white70, fontSize: 18),
          ),
          SizedBox(height: 8),
          Text(
            displayValue,
            style: TextStyle(
                color: Colors.white, fontSize: 36, fontWeight: FontWeight.bold),
          ),
          SizedBox(height: 8),
          // Conditionally display the bar graph or the progress bar
          if (isGraphMode && graphData != null)
            BarGraphComponent(
              dataValues: graphData!,
              goalValue: goalValue!
                  .toDouble(), // Pass the goalValue to the BarGraphComponent
            )
          else if (goalValue != null)
            Column(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.all(Radius.circular(10)),
                  child: LinearProgressIndicator(
                    value: progress,
                    backgroundColor: Colors.grey[800],
                    valueColor: AlwaysStoppedAnimation<Color>(barColor),
                    minHeight: 10,
                  ),
                ),
                SizedBox(height: 8),
                Text(
                  'Goal ${getDisplayValue(goalValue!.toDouble(), units, imperial)}',
                  style: TextStyle(color: Colors.white70),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

and our bargraphcomponent.dart

import 'package:flutter/material.dart';
import 'dart:math' as math;

class BarGraphComponent extends StatelessWidget {
  final List<double> dataValues;
  final double goalValue;

  const BarGraphComponent({
    Key? key,
    required this.dataValues,
    required this.goalValue,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Find the maximum value in the dataset
    final double dataMax = dataValues.reduce(math.max);
    // Calculate the maximum value for the graph so that the goal line is at 2/3 of the graph's height
    final double calculatedMaxValue =
        dataMax >= goalValue ? dataMax : goalValue / (2 / 3);
    final double barAreaHeight = 200.0; // The total height for bars

    // Now create a scaling factor based on the calculatedMaxValue
    double scaleFactor = barAreaHeight / calculatedMaxValue;
    double goalLinePosition = goalValue * scaleFactor;

    // Ensure goal line position is not more than 2/3 of barAreaHeight
    goalLinePosition = math.min(goalLinePosition, barAreaHeight * (2 / 3));

    // Rest of your widget build method
    // ...

    return Container(
      height: barAreaHeight + 32.0, // Total height including padding
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Stack(
        children: [
          // Bars
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: dataValues.map((value) {
              double barHeight = value * scaleFactor;
              bool exceedsGoal = value >= goalValue;
              return Expanded(
                child: Container(
                  margin: EdgeInsets.symmetric(horizontal: 4),
                  height: barHeight,
                  color: exceedsGoal ? Colors.green : Colors.blue,
                ),
              );
            }).toList(),
          ),
          // Goal line
          Positioned(
            bottom: goalLinePosition,
            left: 0,
            right: 0,
            child: Container(
              height: 2,
              color: Colors.red,
            ),
          ),
        ],
      ),
    );
  }
}



To display a graph of the steps taken over the last 7 days in your Flutter application, you will need to modify the `_fetchHealthData` method in your `home.dart` file to fetch step data for each of the past 7 days. Then, you'll pass this data to the `MetricDisplayComponent` where it will be used by the `BarGraphComponent` to render the graph.

Here's how you can modify the `_fetchHealthData` method:

1. **Fetch Steps for Each Day:** Modify the `_fetchHealthData` method to fetch steps for each of the past 7 days. Store these values in a list.

2. **Update State:** Update a state variable (like `List<double> weeklySteps`) with the fetched step values.

3. **Pass Data to Widget:** Pass this `weeklySteps` list to the `MetricDisplayComponent` for the steps metric.

Here's an example implementation:

```dart
// Inside the _MyHomePageState class in home.dart

Future<void> _fetchHealthData() async {
    DateTime endDate = DateTime.now();
    List<double> weeklySteps = [];

    HealthFactory health = HealthFactory();

    for (int i = 6; i >= 0; i--) {
      DateTime startDate = DateTime(endDate.year, endDate.month, endDate.day - i);

      // Fetch steps for each day
      List<HealthDataPoint> stepData = await health
          .getHealthDataFromTypes(startDate, startDate.add(Duration(days: 1)), [HealthDataType.STEPS]);
      int steps = stepData.fold<int>(0, (sum, item) {
        if (item.value is NumericHealthValue) {
          NumericHealthValue numericValue = item.value as NumericHealthValue;
          return sum + numericValue.numericValue.toInt();
        } else {
          print("Unexpected value type for steps: ${item.value.runtimeType}");
          return sum;
        }
      });

      weeklySteps.add(steps.toDouble());
    }

    setState(() {
      this.weeklySteps = weeklySteps;
    });

    // Rest of your existing _fetchHealthData logic...
}
```

Then, in the `build` method of `_MyHomePageState`, pass this `weeklySteps` list to the `MetricDisplayComponent` for the steps metric:

```dart
// Inside the build method of _MyHomePageState in home.dart

MetricDisplayComponent(
  metricName: 'Steps',
  currentValue: weeklySteps.last, // Assuming the last entry is the most recent day
  goalValue: 12000, // Example goal value
  isGraphMode: true, // Enable bar graph mode
  graphData: weeklySteps, // Pass the weekly steps data
),
```

This should display a graph of steps taken over the last 7 days in your app. Make sure to handle any edge cases, like days when no data is available, to ensure a smooth user experience.


**Topic:** [[chatgpt-clusters/coding_mobile]]
