---
title: "Steps Graph in Flutter"
type: guide
created: 2024-01-22
updated: 2024-01-22
source: chatgpt-export
topic: coding-mobile
message_count: 6
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Steps Graph in Flutter

> **Source:** ChatGPT conversation
> **Date:** 2024-01-22T08:37:36Z
> **Messages:** 6
> **Topic:** coding-mobile

## Question

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
        // ... other

## Answer

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

## Question

is this right

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
  do

## Answer

Your implementation in the `_fetchHealthData` method is mostly correct, but there are a few adjustments needed to ensure it works as intended:

1. **Redundant Step Fetching:** In your `_fetchHealthData` method, you are fetching step data twice – once for each of the past 7 days, and again for the total steps during the entire period. You should remove the redundant fetching to improve efficiency.

2. **Use of `weeklySteps`:** You have declared `weeklySteps` both locally within the `_fetchHealthData` method and again in the `build` method. It would be more appropriate to declare `weeklySteps` as a state variable of `_MyHomePageState` class so that it's accessible throughout the class.

3. **Variable Shadowing:** In the loop within `_fetchHealthData`, the `startDate` variable is redeclared, which could lead to confusion. It's better to use a different variable name for the loop iteration.

4. **Update Widget Rendering:** Ensure that the `MetricDisplayComponent` for steps in the `build` method uses the `weeklySteps` state variable to display the graph.

Here's the adjusted `_fetchHealthData` method:

```dart
Future<void> _fetchHealthData() async {
  DateTime endDate = DateTime.now();
  List<double> weeklyStepsTemp = []; // Temporary list to store steps data

  HealthFactory health = HealthFactory();

  // Request authorization
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

      // Fetch steps for each day
      List<HealthDataPoint> stepData = await health.getHealthDataFromTypes(
          day, day.add(Duration(days: 1)), [HealthDataType.STEPS]);
      int steps = stepData.fold<int>(0, (sum, item) {
        return sum + (item.value as NumericHealthValue).numericValue.toInt();
      });

      weeklyStepsTemp.add(steps.toDouble());
    }

    // Rest of your data fetching logic (for weight, body fat, height, etc.)

    setState(() {
      this.weeklySteps = weeklyStepsTemp; // Update the state variable
      // Update other state variables like _stepCount, _latestWeight, etc.
    });
  } else {
    print("Health data access not granted");
  }
}
```

Then, make sure the `build` method uses the `weeklySteps` state variable:

```dart
MetricDisplayComponent(
  metricName: 'Steps',
  currentValue: weeklySteps.last, // Use the state variable
  goalValue: 12000,
  isGraphMode: true,
  graphData: weeklySteps,
),
```

With these changes, your app should correctly fetch and display the steps data for the past 7 days.

## Question

give me the full home.dart component refactored with these changes

## Answer

Sure, here's the refactored `home.dart` component with the suggested changes:

```dart
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
  int _selectedIndex = 0;
  int _stepCount = 0;
  double _latestWeight = 0.0;
  double _height = 0.0;
  double _bodyFatPercentage = 0.0;
  List<double> weeklySteps = [];

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

    double ffmiCalculated 

*(Answer truncated — 5785 chars total)*
