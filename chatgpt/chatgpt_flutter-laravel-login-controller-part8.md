
ok check my implementation. is it correct?

import 'package:flutter/material.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'login_page.dart';
import 'package:superheromobile/user.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'user.dart';
import 'home.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final storage = FlutterSecureStorage();
  String? token = await storage.read(key: 'authToken');

  runApp(MyApp(isLoggedIn: token != null));
}

class MyApp extends StatelessWidget {
  final bool isLoggedIn;

  MyApp({required this.isLoggedIn});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Superhero Mode',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      themeMode: ThemeMode
          .dark, //Always use the dark mode (if available) regardless of system preference.
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black, // Set background color to black
      ),
      home: isLoggedIn ? MyHomePage(title: 'Superhero Mode') : LoginPage(),
    );
  }
}

String formatLargeNumber(double number) {
  if (number >= 1000000000) {
    return '${(number / 1000000000).toStringAsFixed(1)}b';
  } else if (number >= 1000000) {
    return '${(number / 1000000).toStringAsFixed(1)}m';
  } else if (number >= 1000) {
    return '${(number / 1000).toStringAsFixed(1)}k';
  } else {
    return number.toStringAsFixed(1);
  }
}

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

    bool isMetric = user.isMetric;
    double ffmi = user.calculateFFMI();

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            widget.title,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 24,
              color: Colors.white,
            ),
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
        onRefresh: _fetchHealthData,
        child: Column(
          children: [
            // Display user's name
            Padding(
              padding: const EdgeInsets.all(8.0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  user.currentUser?.name ?? 'User',
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
            Expanded(
              child: GridView.count(
                crossAxisCount: 2, // Adjust the number of columns
                childAspectRatio: 1.3, // Adjust the aspect ratio
                children: <Widget>[
                  _featuredStatCard(
                      'FFMI', ffmi, Colors.blue, context), // Add this line
                  _dataDisplayCard(
                      'Steps', _stepCount.toDouble(), Colors.blue, context),
                  _dataDisplayCard(
                      'Weight', _latestWeight, Colors.green, context),
                  _dataDisplayCard('Height', _height, Colors.purple, context),
                  _dataDisplayCard(
                      'Age',
                      user.birthday != null
                          ? _calculateAge(user.birthday!).toDouble()
                          : 0.0,
                      Colors.orange,
                      context),

                  _dataDisplayCard(
                      'Body Fat', _bodyFatPercentage, Colors.red, context)
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
          BottomNavigationBarItem(icon: Icon(Icons.login), label: 'Login')
        ],
        currentIndex: _selectedIndex,
        onTap: _onItemTapped,
      ),
    );
  }

  void updateHeight(double newHeight) {
    setState(() {
      _height = newHeight;
    });
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });

    if (index == 1) {
      // Assuming the login button is at index 2
      Navigator.push(
        context,
        MaterialPageRoute(builder: (context) => LoginPage()),
      );
    }
  }

  Widget _dataDisplayCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue;

    if (label == 'Steps') {
      displayValue = formatLargeNumber(value);
    } else {
      displayValue = _getFormattedValue(label, value, context);
    }

    return Card(
      color: Colors.grey[950],
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.normal,
                  color: Colors.grey[400]),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 32,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  Widget _featuredStatCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue = _getFormattedValue(label, value, context);

    return Card(
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 48,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  String _getFormattedValue(String label, double value, BuildContext context) {
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;

    switch (label) {
      case 'Weight':
        return isMetric
            ? '${value.toStringAsFixed(2)} kg'
            : '${(value * 2.20462).toStringAsFixed(2)} lbs';
      case 'Height':
        if (isMetric) {
          return '${value.toStringAsFixed(2)} m';
        } else {
          value = value * 3.281; // Convert meters to feet
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

class SettingsPage extends StatefulWidget {
  @override
  _SettingsPageState createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  DateTime? _birthday;

  Future<void> _selectDate(BuildContext context) async {
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: _birthday ?? DateTime.now(),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
    );
    if (picked != null && picked != _birthday) {
      setState(() {
        _birthday = picked;
      });
      // Update the birthday in the UserModel
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Fetch the user model using Provider
    final user = Provider.of<UserModel>(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Settings'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text('Birthday: ${_birthday?.toIso8601String() ?? "Not set"}'),
            ElevatedButton(
              onPressed: () => _selectDate(context),
              child: Text('Select your birthday'),
            ),
            SwitchListTile(
              title: Text('Use metric units'),
              value: user.isMetric,
              onChanged: (bool value) {
                user.toggleUnitPreference();
              },
            ),
          ],
        ),
      ),
    );
  }
}

/* class UserModel extends ChangeNotifier {
  DateTime? birthday;
  double? weight;
  double? height;
  double? bodyFatPercentage;
  double calculateFFMI() {
    if (weight == null || bodyFatPercentage == null || height == null) {
      return 0.0; // Return a default value if any of the properties is null
    }

    double leanBodyMass = weight! * (1 - (bodyFatPercentage! / 100));
    double heightInMeters = isMetric ? height! : height! * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  bool isMetric = true; // Add this line

  void updateBirthday(DateTime newBirthday) {
    birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  void toggleUnitPreference() {
    // Add this method
    isMetric = !isMetric;
    notifyListeners();
  }
} */



Your implementation looks correct with regard to starting the app on the login screen if the user is not logged in, and then transitioning to the home screen upon successful login. Here are a few points to ensure everything works as expected:

1. **Secure Storage Usage**: You're correctly using `flutter_secure_storage` to check if the user token exists, which determines the login status. Make sure the token is being stored and retrieved correctly in the login and logout functionalities.

2. **Home Page Display**: You're correctly displaying the user's name on the home screen. Ensure that the user's name is being updated in the `UserModel` when they log in.

3. **Login Flow**: In the `login` method of your `LoginPage`, you're fetching user details and updating the `UserModel` with `Provider.of<UserModel>(context, listen: false).setUser(user);`. Ensure that `setUser` is a method in `UserModel` that updates the user information and calls `notifyListeners()`.

4. **Navigation to Home Page**: After a successful login, you might need to navigate to the home page explicitly. This can be done using `Navigator` if it's not already handled.

5. **Logout Functionality**: Ensure there's a way for users to log out, which should clear the stored token and navigate back to the login screen.

6. **Error Handling**: Make sure to handle any potential errors during login, and inform the user appropriately if something goes wrong.

7. **Testing**: Thoroughly test the login and logout functionalities to ensure they work as expected across different scenarios.

If you have all these points covered, your implementation should work as intended.


type null is not a subtype of bool


The error "type null is not a subtype of bool" typically occurs in Dart/Flutter when you're trying to use a variable that is `null` as a boolean value. This often happens when you're accessing a value that can potentially be `null` without checking if it's actually `null`.

In your case, without seeing the specific line of code that's throwing this error, I can suggest a few general places to check:

1. **Checking Logged In Status**: When you check if the user is logged in, ensure that the token variable is properly checked for `null`. For instance:

    ```dart
    String? token = await storage.read(key: 'authToken');
    runApp(MyApp(isLoggedIn: token != null));
    ```

    In this snippet, if `token` is `null`, `token != null` should safely return `false`.

2. **User Model**: When accessing properties of the `UserModel` that can be `null`, ensure that you're handling the `null` case. For example, when displaying the user's name, you might want to check if the user is `null` before accessing its properties.

    ```dart
    Text(
      user.currentUser?.name ?? 'User',
      style: TextStyle(
        fontSize: 24,
        fontWeight: FontWeight.bold,
        color: Colors.white,
      ),
    ),
    ```

    This code will safely fall back to the string `'User'` if `currentUser` or `name` is `null`.

3. **Anywhere Else You Use Booleans**: Check other parts of your code where you might be using a boolean that could potentially be `null`. For instance, when using the `isMetric` flag from `UserModel`, ensure it's properly initialized and not `null`.

If you can provide the specific section of the code where the error occurs, I can give a more targeted suggestion.


ok lets implement the check for if the user is logged in and use that to change the login button to a logout button

import 'package:flutter/material.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'login_page.dart';
import 'package:superheromobile/user.dart';
import 'user.dart';
import 'home.dart';

void main() {
  runApp(
    ChangeNotifierProvider(
      create: (context) => UserModel(),
      child: MyApp(),
    ),
  );
}

String formatLargeNumber(double number) {
  if (number >= 1000000000) {
    return '${(number / 1000000000).toStringAsFixed(1)}b';
  } else if (number >= 1000000) {
    return '${(number / 1000000).toStringAsFixed(1)}m';
  } else if (number >= 1000) {
    return '${(number / 1000).toStringAsFixed(1)}k';
  } else {
    return number.toStringAsFixed(1);
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Superhero Mode',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      themeMode: ThemeMode
          .dark, //Always use the dark mode (if available) regardless of system preference.
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black, // Set background color to black
      ),
      home: const MyHomePage(title: 'Superhero Mode'),
    );
  }
}

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

    bool isMetric = user.isMetric;
    double ffmi = user.calculateFFMI();

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            widget.title,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 24,
              color: Colors.white,
            ),
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
            Expanded(
              child: GridView.count(
                crossAxisCount: 2, // Adjust the number of columns
                childAspectRatio: 1.3, // Adjust the aspect ratio
                children: <Widget>[
                  _featuredStatCard(
                      'FFMI', ffmi, Colors.blue, context), // Add this line
                  _dataDisplayCard(
                      'Steps', _stepCount.toDouble(), Colors.blue, context),
                  _dataDisplayCard(
                      'Weight', _latestWeight, Colors.green, context),
                  _dataDisplayCard('Height', _height, Colors.purple, context),
                  _dataDisplayCard(
                      'Age',
                      user.birthday != null
                          ? _calculateAge(user.birthday!).toDouble()
                          : 0.0,
                      Colors.orange,
                      context),

                  _dataDisplayCard(
                      'Body Fat', _bodyFatPercentage, Colors.red, context)
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
          BottomNavigationBarItem(icon: Icon(Icons.login), label: 'Login')
        ],
        currentIndex: _selectedIndex,
        onTap: _onItemTapped,
      ),
    );
  }

  void updateHeight(double newHeight) {
    setState(() {
      _height = newHeight;
    });
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });

    if (index == 1) {
      // Assuming the login button is at index 2
      Navigator.push(
        context,
        MaterialPageRoute(builder: (context) => LoginPage()),
      );
    }
  }

  Widget _dataDisplayCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue;

    if (label == 'Steps') {
      displayValue = formatLargeNumber(value);
    } else {
      displayValue = _getFormattedValue(label, value, context);
    }

    return Card(
      color: Colors.grey[950],
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.normal,
                  color: Colors.grey[400]),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 32,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  Widget _featuredStatCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue = _getFormattedValue(label, value, context);

    return Card(
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 48,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  String _getFormattedValue(String label, double value, BuildContext context) {
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;

    switch (label) {
      case 'Weight':
        return isMetric
            ? '${value.toStringAsFixed(2)} kg'
            : '${(value * 2.20462).toStringAsFixed(2)} lbs';
      case 'Height':
        if (isMetric) {
          return '${value.toStringAsFixed(2)} m';
        } else {
          value = value * 3.281; // Convert meters to feet
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

class SettingsPage extends StatefulWidget {
  @override
  _SettingsPageState createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  DateTime? _birthday;

  Future<void> _selectDate(BuildContext context) async {
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: _birthday ?? DateTime.now(),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
    );
    if (picked != null && picked != _birthday) {
      setState(() {
        _birthday = picked;
      });
      // Update the birthday in the UserModel
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Fetch the user model using Provider
    final user = Provider.of<UserModel>(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Settings'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text('Birthday: ${_birthday?.toIso8601String() ?? "Not set"}'),
            ElevatedButton(
              onPressed: () => _selectDate(context),
              child: Text('Select your birthday'),
            ),
            SwitchListTile(
              title: Text('Use metric units'),
              value: user.isMetric,
              onChanged: (bool value) {
                user.toggleUnitPreference();
              },
            ),
          ],
        ),
      ),
    );
  }
}

/* class UserModel extends ChangeNotifier {
  DateTime? birthday;
  double? weight;
  double? height;
  double? bodyFatPercentage;
  double calculateFFMI() {
    if (weight == null || bodyFatPercentage == null || height == null) {
      return 0.0; // Return a default value if any of the properties is null
    }

    double leanBodyMass = weight! * (1 - (bodyFatPercentage! / 100));
    double heightInMeters = isMetric ? height! : height! * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  bool isMetric = true; // Add this line

  void updateBirthday(DateTime newBirthday) {
    birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  void toggleUnitPreference() {
    // Add this method
    isMetric = !isMetric;
    notifyListeners();
  }
} */



Your implementation looks good, but there are a few changes and additions you need to make to handle the login/logout process effectively. Specifically, you need to:

1. **Check if the user is logged in**: This can be done by checking if there's a token stored securely (as you've already planned). However, this should be done in the `MyApp` widget or a similar initialization point.

2. **Change the login/logout button dynamically**: You need to update the `BottomNavigationBarItem` to display either a login or a logout icon and label based on the user's logged-in status.

3. **Handle the logout functionality**: You should clear the token and update the state to reflect that the user is logged out.

Here's an updated version of your code with these considerations:

```dart
// ... [Previous code]

class _MyHomePageState extends State<MyHomePage> {
  // ... [Existing members and methods]

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

  @override
  Widget build(BuildContext context) {
    final user = context.watch<UserModel>();
    // ... [Existing build method code]

    return Scaffold(
      // ... [Existing Scaffold code]

      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: Colors.black,
        items: <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.home),
            label: 'Home',
          ),
          BottomNavigationBarItem(
            icon: Icon(user.currentUser != null ? Icons.exit_to_app : Icons.login),
            label: user.currentUser != null ? 'Logout' : 'Login'
          )
        ],
        currentIndex: _selectedIndex,
        onTap: (index) {
          if (index == 1 && user.currentUser != null) {
            _logout();
          } else {
            setState(() {
              _selectedIndex = index;
            });

            if (index == 1) {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => LoginPage()),
              );
            }
          }
        },
      ),
    );
  }

  // ... [Rest of your code]
}

// ... [Rest of the file]
```

In this code:

- The `BottomNavigationBarItem` for login/logout changes based on whether `user.currentUser` is null or not.
- The `_logout` method clears the stored token and navigates to the `LoginPage`.
- The `onTap` handler for the `BottomNavigationBar` checks if the user is logged in and calls `_logout` if the logout button is tapped.

Make sure the rest of your app logic aligns with these changes, especially how you manage the user state across different parts of the app.


r fixing the above error(s).

lib/main.dart:257:19: Error: Not a constant expression.
                  user.currentUser != null ? Icons.exit_to_app : Icons.login),
                  ^^^^
lib/main.dart:258:22: Error: Not a constant expression.
              label: user.currentUser != null ? 'Logout' : 'Login')
                     ^^^^
Performing hot reload...      


The issue you're facing is due to trying to use a non-constant expression (`user.currentUser != null`) inside a `const BottomNavigationBarItem`. In Flutter, when you use the `const` keyword, all the expressions within that widget must also be compile-time constants. However, `user.currentUser` is a runtime value and not a constant.

To resolve this issue, you need to remove the `const` keyword from the `BottomNavigationBarItem`. Here's the corrected code:

```dart
bottomNavigationBar: BottomNavigationBar(
  backgroundColor: Colors.black,
  items: <BottomNavigationBarItem>[
    BottomNavigationBarItem(
      icon: Icon(Icons.home),
      label: 'Home',
    ),
    BottomNavigationBarItem(
      icon: Icon(user.currentUser != null ? Icons.exit_to_app : Icons.login),
      label: user.currentUser != null ? 'Logout' : 'Login'
    )
  ],
  currentIndex: _selectedIndex,
  onTap: (index) {
    if (index == 1 && user.currentUser != null) {
      _logout();
    } else {
      setState(() {
        _selectedIndex = index;
      });

      if (index == 1) {
        Navigator.push(
          context,
          MaterialPageRoute(builder: (context) => LoginPage()),
        );
      }
    }
  },
),
```

Make sure to apply this change to all instances where you have used `const BottomNavigationBarItem` and are trying to use runtime values inside them. This change will ensure that your widget can rebuild with the correct icons and labels based on the user's logged-in status.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_flutter-laravel-login-controller-part1]]
- [[chatgpt/chatgpt_flutter-laravel-login-controller-part10]]
- [[chatgpt/chatgpt_flutter-laravel-login-controller-part11]]
- [[chatgpt/chatgpt_flutter-laravel-login-controller-part2]]
- [[chatgpt/chatgpt_flutter-laravel-login-controller-part3]]
