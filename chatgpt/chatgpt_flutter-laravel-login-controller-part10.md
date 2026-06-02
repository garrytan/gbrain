
import 'package:flutter/material.dart';
import 'user.dart';

class ProfilePage extends StatelessWidget {
  final UserModel user;

  ProfilePage({required this.user});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              user.currentUser!.email,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Email:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(user.currentUser?.email ?? 'N/A'),
                ),
              ],
            ),
            SizedBox(height: 8.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Height:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(user.height.toString()),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}



Your `ProfilePage` widget looks mostly fine, but there are a few things you might want to consider or change:

1. You're showing the email twice: once prominently at the top and again in the details list. You might want to display different information at the top, such as the user's name if available.

2. When displaying optional data like `height`, which could potentially be `null`, you should handle it gracefully. For example, you can show a default message when the data is not available.

3. If `currentUser` could be `null`, you should check for `null` before accessing its properties to prevent runtime errors.

Here is the updated code considering these points:

```dart
import 'package:flutter/material.dart';
import 'user.dart';

class ProfilePage extends StatelessWidget {
  final UserModel user;

  ProfilePage({required this.user});

  @override
  Widget build(BuildContext context) {
    // Check if the currentUser is not null
    final currentUser = user.currentUser;
    if (currentUser == null) {
      // If currentUser is null, return an error message or a different widget
      return Scaffold(
        appBar: AppBar(title: Text('Profile')),
        body: Center(child: Text('No user data available')),
      );
    }

    // If currentUser is not null, build the profile page
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              currentUser.name, // Assuming you have a name field
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Email:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(currentUser.email),
                ),
              ],
            ),
            SizedBox(height: 8.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Height:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  // Display height if not null, otherwise display 'N/A'
                  child: Text(user.height?.toString() ?? 'N/A'),
                ),
              ],
            ),
            // Add more user details here
          ],
        ),
      ),
    );
  }
}
```

In this updated code:

- Added a check to ensure `currentUser` is not `null` before trying to access its properties.
- Replaced the redundant email display at the top with `currentUser.name`, assuming you have a `name` field in your `User` model.
- Added null-aware access to `user.height` when displaying the height, showing 'N/A' if it's `null`.




lib/main.dart:308:67: Error: The getter 'currentUser' isn't defined for the class '_MyHomePageState'.
 - '_MyHomePageState' is from 'package:superheromobile/main.dart' ('lib/main.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field named 'currentUser'.
        MaterialPageRoute(builder: (context) => ProfilePage(user: currentUser)),
                                                                  ^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


The error indicates that `currentUser` is being referenced in a context where it's not defined. Inside `_MyHomePageState`, `currentUser` is not a direct property; you need to get it from the `UserModel` object.

You need to fetch the `UserModel` instance from the provider and then pass the entire user model to the `ProfilePage`. Here's how you could do it:

```dart
// Inside the _MyHomePageState class
void _goToProfile() {
  // Assuming you have a BuildContext available as `context`
  UserModel userModel = Provider.of<UserModel>(context, listen: false);
  Navigator.push(
    context,
    MaterialPageRoute(
      builder: (context) => ProfilePage(user: userModel),
    ),
  );
}
```

Then you would call `_goToProfile` wherever you need to navigate to the `ProfilePage`. The actual implementation may vary depending on how your navigation and state management are set up.

Make sure to adjust the `ProfilePage` to accept a `UserModel` instead of `currentUser` if necessary, like so:

```dart
class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  ProfilePage({required this.userModel});

  // ... rest of your code
}
```

This change ensures that the `ProfilePage` receives the entire user model, from which it can extract the current user and any other necessary information.


flutter: Error fetching user details: FormatException: Invalid radix-10 number (at character 1)
193.04
^



The error message indicates that there's an attempt to parse a non-integer string (`"193.04"`) as an integer. This is likely happening because you're using a function that expects an integer input (such as `int.parse`), but the actual input is a string representing a floating-point number.

Here's a possible scenario where this could happen: you are fetching user details from an API or some other data source, and you're trying to parse a number that you expect to be an integer, but it's actually a string with a decimal point.

To fix this, you should use `double.parse` if you expect the number to have decimal places:

```dart
double myNumber = double.parse('193.04');
```

Make sure you check the data you are parsing and use the appropriate parsing method. If the context of the data allows for both integers and floating-point numbers, you may want to add some logic to handle both cases:

```dart
dynamic parseNumber(String numberString) {
  if (numberString.contains('.')) {
    return double.parse(numberString);
  } else {
    return int.parse(numberString);
  }
}
```

This function checks if the string contains a decimal point and then decides whether to parse it as a `double` or an `int`.

If you're receiving this data from an external source (like an API), ensure that the data format is consistent with your expectations, and handle exceptions where the format might differ. It's also a good practice to wrap your parsing code in try-catch blocks to manage exceptions gracefully:

```dart
try {
  double myNumber = double.parse('193.04');
  // Handle the number as needed
} catch (e) {
  // Handle or log the exception
  print('An error occurred while parsing the number: $e');
}
```

Without the exact code where the error occurs, this is a general solution. You'd need to apply it to the specific part of your codebase that's responsible for parsing the number.


ok so now here is my user.dart file
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

class User {
  final int id;
  final String name;
  final String email;
  final int age;
  final double height;

  User({
    required this.id,
    required this.name,
    required this.email,
    required this.age,
    required this.height,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'],
      height: double.parse(json['height']),
    );
  }
}

class UserModel extends ChangeNotifier {
  User? _currentUser;
  DateTime? _birthday;
  double? _weight;
  double? _height;
  double? _bodyFatPercentage;
  bool _isMetric = true;

  User? get currentUser => _currentUser;
  DateTime? get birthday => _birthday;
  double? get weight => _weight;
  double? get height => _height;
  double? get bodyFatPercentage => _bodyFatPercentage;
  bool get isMetric => _isMetric;

  void setCurrentUser(User user) {
    _currentUser = user;
    notifyListeners();
  }

  void updateBirthday(DateTime newBirthday) {
    _birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    _weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    _height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    _bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  void toggleUnitPreference() {
    _isMetric = !_isMetric;
    notifyListeners();
  }

  double calculateFFMI() {
    if (_weight == null ||
        _bodyFatPercentage == null ||
        currentUser?.height == 0.0) {
      return 0.0;
    }

    double leanBodyMass = _weight! * (1 - (_bodyFatPercentage! / 100));
    double heightInMeters =
        _isMetric ? currentUser!.height : currentUser!.height * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  // Add any other user-related methods and logic here
}


and here is my profile page file
import 'package:flutter/material.dart';
import 'user.dart';

class ProfilePage extends StatelessWidget {
  User? currentUser;
  @override
  Widget build(BuildContext context) {
    // Check if the currentUser is not null
    Scaffold(
      appBar: AppBar(title: Text('Profile')),
      body: Center(child: Text('No user data available')),
    );

    // If currentUser is not null, build the profile page
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              currentUser?.name ?? 'N/A', // Assuming you have a name field
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Email:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  child: Text('currentUser.email'),
                ),
              ],
            ),
            SizedBox(height: 8.0),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Height:',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Expanded(
                  // Display height if not null, otherwise display 'N/A'
                  child: Text('N/A'),
                ),
              ],
            ),
            // Add more user details here
          ],
        ),
      ),
    );
  }
}


why is the user name not showing on the profile page


In your `ProfilePage` class, the `currentUser` property should be initialized via the constructor if you want to pass the `UserModel` from the previous page. However, it seems you're not passing it correctly.

Here is how you could adjust the `ProfilePage`:

```dart
class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  // Accept the UserModel as a parameter in the constructor
  ProfilePage({Key? key, required this.userModel}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Access the current user from userModel
    final currentUser = userModel.currentUser;

    // If currentUser is null, return a Scaffold with 'No user data available'
    if (currentUser == null) {
      return Scaffold(
        appBar: AppBar(title: Text('Profile')),
        body: Center(child: Text('No user data available')),
      );
    }

    // If currentUser is not null, build the profile page with user data
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              currentUser.name,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Text('Email: ${currentUser.email}'),
            SizedBox(height: 8.0),
            Text('Height: ${currentUser.height}'),
            // Add more user details here
          ],
        ),
      ),
    );
  }
}
```

Make sure you pass the `UserModel` to the `ProfilePage` like this:

```dart
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => ProfilePage(userModel: userModel),
  ),
);
```

Replace `userModel` with your instance of `UserModel`. 

In addition, make sure that the `UserModel` has the current user set before navigating to the `ProfilePage`. If the current user is `null`, the `ProfilePage` will display "No user data available". If the user is not `null`, it will display the user's details.

Lastly, in your `ProfilePage`, you have a `return` statement that does not do anything because it's after the `Scaffold` that gets returned when `currentUser` is `null`. The second `Scaffold` is unreachable code if `currentUser` is `null`. Make sure to correct this logic based on whether you expect `currentUser` to be nullable. If `currentUser` should always have a value when `ProfilePage` is built, you may remove the null check and directly use the user's data.


import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'login_page.dart';
import 'package:superheromobile/user.dart';
import 'user.dart';
import 'home.dart';
import 'profile.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final storage = FlutterSecureStorage();
  String? token = await storage.read(key: 'authToken');

  bool isLoggedIn = token != null;

  runApp(
    ChangeNotifierProvider(
      create: (context) => UserModel(),
      child: MyApp(isLoggedIn: isLoggedIn),
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
  final bool isLoggedIn;

  MyApp({required this.isLoggedIn});

  /* const MyApp({super.key}); */

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
/*   void _goToProfile() {
    // Assuming you have a BuildContext available as `context`
    UserModel userModel = Provider.of<UserModel>(context, listen: false);
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ProfilePage(user: userModel),
      ),
    );
  } */

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
                  _dataDisplayCard(
                      'Height',
                      user.currentUser?.height.toDouble() ?? 0.0,
                      Colors.purple,
                      context),
                  _dataDisplayCard(
                      'Age',
                      user.currentUser?.age.toDouble() ?? 0.0,
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
          BottomNavigationBarItem(icon: Icon(Icons.login), label: 'Login'),
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
      // Assuming the login button is at index 2
      Navigator.push(
        context,
        MaterialPageRoute(builder: (context) => LoginPage()),
      );
    } else if (index == 2) {
      // Assuming the profile button is at index 3
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => ProfilePage(userModel: userModel),
        ),
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

is this right


You have the right idea, but there are a few issues in the code that need to be addressed:

1. You commented out the `_goToProfile` method. You should uncomment it and correct the parameter passed to `ProfilePage` to use the `userModel` from the provider.

2. In the `ProfilePage` class, you are not correctly using the `userModel`. You should accept it as a constructor parameter and use it within the widget.

3. In `_onItemTapped`, you are passing `userModel` to `ProfilePage`, but `userModel` is not defined within the scope of that method. You need to get it from the provider context.

Here's how you can modify the `_MyHomePageState` class:

```dart
class _MyHomePageState extends State<MyHomePage> {
  // ... your existing code ...

  void _onItemTapped(int index) {
    if (index == 2) { // Assuming index 2 is for the Profile page
      UserModel userModel = Provider.of<UserModel>(context, listen: false);
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => ProfilePage(userModel: userModel),
        ),
      );
    } else {
      // handle other navigation
    }
  }

  // ... rest of your code ...
}
```

And here is the corrected `ProfilePage`:

```dart
class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  ProfilePage({Key? key, required this.userModel}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Access the current user from userModel
    final currentUser = userModel.currentUser;

    // If currentUser is null, return a Scaffold with 'No user data available'
    if (currentUser == null) {
      return Scaffold(
        appBar: AppBar(title: Text('Profile')),
        body: Center(child: Text('No user data available')),
      );
    }

    // If currentUser is not null, build the profile page with user data
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              currentUser.name,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Text('Email: ${currentUser.email}'),
            SizedBox(height: 8.0),
            Text('Height: ${currentUser.height}'),
            // Add more user details here
          ],
        ),
      ),
    );
  }
}
```

Make sure to call `_onItemTapped` with the correct index when the profile icon is tapped in the `BottomNavigationBar`. The indices in the `BottomNavigationBar` should match with the ones you are checking in the `_onItemTapped` method.



 ^^^^
lib/profile.dart:7:3: Context: Found this candidate, but the arguments don't match.
  ProfilePage({Key? key, required this.userModel}) : super(key: key);
  ^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).



The error message indicates that there's an issue with how the `ProfilePage` is being called. It seems that the `ProfilePage` constructor expects a parameter named `userModel`, but the actual call from `_onItemTapped` might not be providing it or not providing it correctly.

Let's make sure the `ProfilePage` constructor and the call from `_onItemTapped` match:

First, here's what your `ProfilePage` constructor should look like:

```dart
class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  const ProfilePage({Key? key, required this.userModel}) : super(key: key);

  // Rest of your ProfilePage code...
}
```

Now, when you're calling `ProfilePage` from `_onItemTapped`, make sure to pass the `userModel` like this:

```dart
void _onItemTapped(int index) {
  setState(() {
    _selectedIndex = index;
  });

  if (index == 2) { // Adjust the index based on your BottomNavigationBar
    // Retrieve the user model using Provider
    UserModel userModel = Provider.of<UserModel>(context, listen: false);
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ProfilePage(userModel: userModel),
      ),
    );
  } else if (index == 1) {
    // Your logic for other index taps
  }
}
```

Make sure that the `userModel` you're passing to `ProfilePage` when calling `Navigator.push` is obtained from the provider correctly, and that it matches the constructor of `ProfilePage`.

If you're still getting errors, please double-check that you're using the latest code I've provided and that you've saved all the changes in your files before performing a hot reload or restart.


error(s).

lib/main.dart:106:43: Error: No named parameter with the name 'user'.
        builder: (context) => ProfilePage(user: userModel),
                                          ^^^^
lib/profile.dart:7:9: Context: Found this candidate, but the arguments don't match.
  const ProfilePage({Key? key, required this.userModel}) : super(key: key);
        ^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


Based on the error message, it seems there is a mismatch between the named parameter expected by the `ProfilePage` constructor and the one provided in the `Navigator.push` call. The `ProfilePage` constructor is expecting a parameter named `userModel`, but the code is trying to pass a parameter named `user`.

Here is how you can correct the `Navigator.push` call:

```dart
void _onItemTapped(int index) {
  setState(() {
    _selectedIndex = index;
  });

  if (index == 2) { // Adjust the index based on your BottomNavigationBar
    // Retrieve the user model using Provider
    UserModel userModel = Provider.of<UserModel>(context, listen: false);
    Navigator.push(
      context,
      MaterialPageRoute(
        // Make sure to use the correct named parameter 'userModel' here
        builder: (context) => ProfilePage(userModel: userModel),
      ),
    );
  } else if (index == 1) {
    // Your logic for other index taps
  }
}
```

Ensure that you are using the correct parameter name as per the `ProfilePage` constructor definition. If the constructor expects `userModel`, then you should use `userModel: userModel` in the call, not `user: userModel`. 

Make sure to check your `ProfilePage` class constructor to confirm the parameter names and use them accordingly in the `Navigator.push` call.


here is the user.dart file.
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

class User {
  final int id;
  final String name;
  final String email;
  final int age;
  final double height;

  User({
    required this.id,
    required this.name,
    required this.email,
    required this.age,
    required this.height,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'],
      height: double.parse(json['height']),
    );
  }
}

class UserModel extends ChangeNotifier {
  User? _currentUser;
  DateTime? _birthday;
  double? _weight;
  double? _height;
  double? _bodyFatPercentage;
  bool _isMetric = true;

  User? get currentUser => _currentUser;
  DateTime? get birthday => _birthday;
  double? get weight => _weight;
  double? get height => _height;
  double? get bodyFatPercentage => _bodyFatPercentage;
  bool get isMetric => _isMetric;

  void setCurrentUser(User user) {
    _currentUser = user;
    notifyListeners();
  }

  void updateBirthday(DateTime newBirthday) {
    _birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    _weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    _height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    _bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  void toggleUnitPreference() {
    _isMetric = !_isMetric;
    notifyListeners();
  }

  double calculateFFMI() {
    if (_weight == null ||
        _bodyFatPercentage == null ||
        currentUser?.height == 0.0) {
      return 0.0;
    }

    double leanBodyMass = _weight! * (1 - (_bodyFatPercentage! / 100));
    double heightInMeters =
        _isMetric ? currentUser!.height : currentUser!.height * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  // Add any other user-related methods and logic here
}


Im still getting the error after making your suggested changes
