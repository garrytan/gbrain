---
title: "Login Page Flutter Code"
type: essay
created: 2024-01-20
updated: 2024-01-20
source: chatgpt-export
conversation_id: 3e587d44-1e07-48f4-ba05-f2065d188eba
message_count: 40
tags: [chatgpt, import, code, long-form]
---
# Login Page Flutter Code

> Conversation ID: 3e587d44-1e07-48f4-ba05-f2065d188eba
> Created: 2024-01-20T01:22:05Z
> Updated: 2024-01-20T20:41:33Z
> Messages: 40


import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:superheromobile/models/user.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/auth.dart';

class LoginPage extends StatefulWidget {
  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;

  Future<void> login(BuildContext context) async {
    if (!_validateInputs()) {
      return;
    }

    setState(() {
      _isLoading = true;
    });

    String email = emailController.text;
    String password = passwordController.text;

    try {
      // Send login request
      var url = Uri.parse('https://superheromode.com/api/login');
      var response = await http.post(url, body: {
        'email': email,
        'password': password,
      });

      // Handle response
      if (response.statusCode == 200) {
        var jsonResponse = json.decode(response.body);
        String token = jsonResponse['token'];

        // Securely store the token for future use
        final storage = FlutterSecureStorage();
        await storage.write(key: 'authToken', value: token);

        User? user = await fetchUserDetails(token);
        if (user != null) {
          Provider.of<UserModel>(context, listen: false).setCurrentUser(user);
          // Navigate to home screen
        } else {
          _showSnackBar(context, 'Failed to fetch user details.');
        }
        Provider.of<AuthModel>(context, listen: false).login();
      } else {
        _showSnackBar(context, 'Login failed. Please try again.');
      }
    } catch (e) {
      _showSnackBar(context, 'An error occurred: ${e.toString()}');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<User?> fetchUserDetails(String token) async {
    try {
      final response = await http.get(
        Uri.parse('https://superheromode.com/api/user'),
        headers: {
          'Authorization': 'Bearer $token',
        },
      );

      if (response.statusCode == 200) {
        return User.fromJson(json.decode(response.body));
      }
    } catch (e) {
      // Handle errors
      print('Error fetching user details: ${e.toString()}');
    }
    return null;
  }

  bool _validateInputs() {
    if (emailController.text.isEmpty || passwordController.text.isEmpty) {
      _showSnackBar(context, 'Email and password cannot be empty.');
      return false;
    }
    return true;
  }

  void _showSnackBar(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Login'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'A7X3',
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
              ),
            ),
            TextFormField(
              controller: emailController,
              decoration: InputDecoration(labelText: 'Email'),
              keyboardType: TextInputType.emailAddress,
            ),
            TextFormField(
              controller: passwordController,
              decoration: InputDecoration(labelText: 'Password'),
              obscureText: true,
            ),
            SizedBox(height: 16),
            _isLoading
                ? CircularProgressIndicator()
                : SizedBox(
                    height: 48,
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () => login(context),
                      child: Text('Login', style: TextStyle(fontSize: 18)),
                    ),
                  ),
          ],
        ),
      ),
    );
  }
}



Your Flutter code for a login page seems well-structured and functional. Here are a few observations and suggestions:

1. **State Management and Context**: You're using the `Provider` package for state management, which is a good choice for Flutter applications. Make sure your `UserModel` and `AuthModel` are properly set up in the widget tree to receive and update the state.

2. **Secure Storage**: Utilizing `FlutterSecureStorage` for storing the authentication token is a secure approach. Ensure that the storage permissions and security settings are appropriately configured.

3. **Error Handling**: The error handling in network requests and fetching user details is done well. You might want to add more specific error handling based on different HTTP status codes or specific error responses from the API for a better user experience.

4. **Input Validation**: The input validation in `_validateInputs` checks for empty fields, which is essential. Consider adding more comprehensive validations, such as email format validation.

5. **UI Feedback**: The use of `CircularProgressIndicator` during loading and `SnackBar` for notifications is good for user feedback. Ensure that the UI is responsive and provides clear feedback during and after the login process.

6. **Navigation after Login**: After successful login, you've mentioned navigating to the home screen but the actual navigation code is not present. Make sure to implement the navigation to the home screen or dashboard upon successful login.

7. **Security Considerations**: Ensure that the password is transmitted securely to the server. It's recommended to use HTTPS for all network requests involving sensitive data.

8. **Testing**: Consider adding widget tests and integration tests to ensure the login functionality works as expected and to catch any future bugs or issues.

Overall, your code is on the right track. Just ensure to handle all edge cases and test thoroughly for a smooth user experience.


{'asset_pointer': 'file-service://file-zRJEaO2Kk8gsop1Omtu6dB1I', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': None, 'size_bytes': 108226, 'width': 946}
ok we need to first modify it to follow the theme of the screenshot attatched


To align your Flutter login page with the provided screenshot theme, consider implementing the following changes:

1. **Dark Theme**: The screenshot indicates a dark theme. Make sure your Flutter app's theme is set to `ThemeData.dark()` or customize it accordingly.

2. **Custom AppBar**: The AppBar in the screenshot has a back arrow and the title 'Welcome back' with a centered alignment. You'll need to adjust the `AppBar` properties.

3. **TextFormField Decoration**: The text fields for email and password should have rounded corners and a fill color that contrasts with the dark background. Use `InputDecoration` to customize this.

4. **Password Visibility Toggle**: Implement a toggle button for showing/hiding the password.

5. **Forgot Password**: Include a 'Forgot your password?' link below the password field.

6. **Login Button**: Style the login button to have rounded corners and a fill that contrasts with the background, similar to the text fields.

7. **Create Account Link**: At the bottom, add a text button or a flat button for 'Create a new account'.

Here is an example code snippet to get you started:

```dart
ThemeData _buildDarkTheme() {
  final ThemeData base = ThemeData.dark();
  return base.copyWith(
    textTheme: TextTheme(
      headline6: TextStyle(color: Colors.white, fontSize: 24),
      // other text styles
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.grey[800],
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8.0),
        borderSide: BorderSide.none,
      ),
      // other decoration properties
    ),
    buttonTheme: ButtonThemeData(
      buttonColor: Colors.grey[700],
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8.0),
      ),
      // other button properties
    ),
    // other theme properties
  );
}

class LoginPage extends StatelessWidget {
  // your existing class code
  // ...

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: _buildDarkTheme(),
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () {
              // Handle back action
            },
          ),
          title: Text('Welcome back', textAlign: TextAlign.center),
          centerTitle: true,
        ),
        body: Padding(
          padding: EdgeInsets.all(16.0),
          child: Column(
            children: [
              // Your existing widgets
              // ...
              // Add 'Forgot your password?' link
              TextButton(
                onPressed: () {
                  // Handle forgot password
                },
                child: Text('Forgot your password?'),
              ),
              // ...
              // Add 'Create a new account' link
              TextButton(
                onPressed: () {
                  // Handle create new account
                },
                child: Text('Create a new account'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

Adjust the code according to your needs, and don't forget to add proper navigation and functionality to the back button, forgot password, and create account actions.


where does this go


The snippet provided outlines a function `_buildDarkTheme()` which creates a `ThemeData` object for a dark theme, and an example `LoginPage` widget that applies this theme. Here's where to place the different parts:

1. **_buildDarkTheme() Function**: This function should be placed outside of the `LoginPage` class, but within the same file. This function is responsible for creating a customized dark theme that you can apply to your app or a specific page.

2. **LoginPage Class**: The `LoginPage` class in the example is a `StatelessWidget`, which you can convert to a `StatefulWidget` if you need to maintain state, as in your original `_LoginPageState` class. Replace your existing `LoginPage` class with the new one if you want to apply the theme only to the login page, or use the `_buildDarkTheme()` function to set the theme for your entire app in the `MaterialApp` widget.

Here's how you might apply the theme to the entire app:

```dart
void main() {
  runApp(MyApp());
}

class MyApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Demo',
      theme: _buildDarkTheme(), // Apply the dark theme here
      home: LoginPage(),
    );
  }
}
```

If you're only applying the theme to the `LoginPage`, you would wrap the `Scaffold` widget in the `LoginPage` build method with a `Theme` widget and pass the dark theme to it:

```dart
@override
Widget build(BuildContext context) {
  return Theme(
    data: _buildDarkTheme(), // Apply the dark theme here
    child: Scaffold(
      // ... rest of your Scaffold code
    ),
  );
}
```

Remember to integrate these changes with the rest of your login page logic, such as form validation and submission, which should remain within the `LoginPage` or `_LoginPageState` class.


modify my existing login page:


import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:superheromobile/models/user.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/auth.dart';

class LoginPage extends StatefulWidget {
  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;

  Future<void> login(BuildContext context) async {
    if (!_validateInputs()) {
      return;
    }

    setState(() {
      _isLoading = true;
    });

    String email = emailController.text;
    String password = passwordController.text;

    try {
      // Send login request
      var url = Uri.parse('https://superheromode.com/api/login');
      var response = await http.post(url, body: {
        'email': email,
        'password': password,
      });

      // Handle response
      if (response.statusCode == 200) {
        var jsonResponse = json.decode(response.body);
        String token = jsonResponse['token'];

        // Securely store the token for future use
        final storage = FlutterSecureStorage();
        await storage.write(key: 'authToken', value: token);

        User? user = await fetchUserDetails(token);
        if (user != null) {
          Provider.of<UserModel>(context, listen: false).setCurrentUser(user);
          // Navigate to home screen
        } else {
          _showSnackBar(context, 'Failed to fetch user details.');
        }
        Provider.of<AuthModel>(context, listen: false).login();
      } else {
        _showSnackBar(context, 'Login failed. Please try again.');
      }
    } catch (e) {
      _showSnackBar(context, 'An error occurred: ${e.toString()}');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<User?> fetchUserDetails(String token) async {
    try {
      final response = await http.get(
        Uri.parse('https://superheromode.com/api/user'),
        headers: {
          'Authorization': 'Bearer $token',
        },
      );

      if (response.statusCode == 200) {
        return User.fromJson(json.decode(response.body));
      }
    } catch (e) {
      // Handle errors
      print('Error fetching user details: ${e.toString()}');
    }
    return null;
  }

  bool _validateInputs() {
    if (emailController.text.isEmpty || passwordController.text.isEmpty) {
      _showSnackBar(context, 'Email and password cannot be empty.');
      return false;
    }
    return true;
  }

  void _showSnackBar(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Login'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'A7X3',
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
              ),
            ),
            TextFormField(
              controller: emailController,
              decoration: InputDecoration(labelText: 'Email'),
              keyboardType: TextInputType.emailAddress,
            ),
            TextFormField(
              controller: passwordController,
              decoration: InputDecoration(labelText: 'Password'),
              obscureText: true,
            ),
            SizedBox(height: 16),
            _isLoading
                ? CircularProgressIndicator()
                : SizedBox(
                    height: 48,
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () => login(context),
                      child: Text('Login', style: TextStyle(fontSize: 18)),
                    ),
                  ),
          ],
        ),
      ),
    );
  }
}


and my main page is:
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/screens/login_page.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/screens/profile.dart';
import 'package:superheromobile/screens/settings_page.dart';
import 'algorithms.dart';
import 'models/auth.dart';

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

ThemeData _buildDarkTheme() {
  final ThemeData base = ThemeData.dark();
  return base.copyWith(
    textTheme: TextTheme(
      headline6: TextStyle(color: Colors.white, fontSize: 24),
      // other text styles
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.grey[800],
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8.0),
        borderSide: BorderSide.none,
      ),
      // other decoration properties
    ),
    buttonTheme: ButtonThemeData(
      buttonColor: Colors.grey[700],
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8.0),
      ),
      // other button properties
    ),
    // other theme properties
  );
}

class MyApp extends StatelessWidget {
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
          .dark, //Always use the dark mode (if available) regardless of system preference.
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black, // Set background color to black
      ),
      routes: {
        '/login': (context) => LoginPage(),
        // ... other routes
      },
      home: isLoggedIn ? MyHomePage(title: 'A7X3') : LoginPage(),
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
                  Text(
                    bodyscore.toStringAsFixed(0), // The large number
                    style: TextStyle(
                      fontSize: 100, // Large font size for the number
                      fontWeight: FontWeight.bold,
                      color: Colors.blue,
                    ),
                  ),
                  Text(
                    'Body Score', // The word "score"
                    style: TextStyle(
                      fontSize: 14, // Smaller font size for the word "score"
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),

            Expanded(
              child: GridView.count(
                crossAxisCount: 2, // Adjust the number of columns
                childAspectRatio: 1.3, // Adjust the aspect ratio
                children: <Widget>[
                  _featuredStatCard('FFMI', ffmiCalculated, Colors.blue,
                      context), // Add this line
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



To modify your existing `LoginPage` to match the theme and design of the screenshot provided, you would need to:

1. Apply the dark theme settings that you have in your `MyApp` class to the `LoginPage`.
2. Adjust the UI elements of `LoginPage` to match the screenshot. This includes text field styles, button styles, and overall layout adjustments.

Below is the modified `LoginPage` along with comments on where to place certain parts:

```dart
// LoginPage remains a StatefulWidget.
class LoginPage extends StatefulWidget {
  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;

  // ... Keep your existing login and other methods here.

  @override
  Widget build(BuildContext context) {
    // Applying the dark theme to this page.
    return Theme(
      data: _buildDarkTheme(),
      child: Scaffold(
        appBar: AppBar(
          title: Text('Welcome back'),
          centerTitle: true, // Center the title
          leading: BackButton(), // Adds a back button to the AppBar
        ),
        body: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                TextFormField(
                  controller: emailController,
                  decoration: InputDecoration(
                    labelText: 'E-mail',
                    filled: true, // Add this line
                    fillColor: Colors.grey[850], // Add this line
                    border: OutlineInputBorder( // Add this line
                      borderRadius: BorderRadius.circular(8.0), // Add this line
                    ),
                  ),
                  keyboardType: TextInputType.emailAddress,
                  style: TextStyle(color: Colors.white), // Add this line
                ),
                SizedBox(height: 16),
                TextFormField(
                  controller: passwordController,
                  decoration: InputDecoration(
                    labelText: 'Password',
                    filled: true, // Add this line
                    fillColor: Colors.grey[850], // Add this line
                    border: OutlineInputBorder( // Add this line
                      borderRadius: BorderRadius.circular(8.0), // Add this line
                    ),
                    suffixIcon: IconButton(
                      icon: Icon(
                        Icons.visibility,
                        color: Colors.white, // Add this line
                      ),
                      onPressed: () {
                        // Add your password visibility toggle functionality
                      },
                    ),
                  ),
                  obscureText: true,
                  style: TextStyle(color: Colors.white), // Add this line
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () {
                      // Add your forgot password functionality
                    },
                    child: Text(
                      'Forgot your password?',
                      style: TextStyle(color: Colors.blue), // Add this line
                    ),
                  ),
                ),
                SizedBox(height: 16),
                _isLoading
                    ? CircularProgressIndicator()
                    : SizedBox(
                        height: 48,
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: () => login(context),
                          style: ElevatedButton.styleFrom(
                            primary: Colors.blue, // Add this line
                            shape: RoundedRectangleBorder( // Add this line
                              borderRadius: BorderRadius.circular(8.0), // Add this line
                            ),
                          ),
                          child: Text('Login', style: TextStyle(fontSize: 18)),
                        ),
                      ),
                TextButton(
                  onPressed: () {
                    // Add your create account functionality
                  },
                  child: Text(
                    'Create a new account',
                    style: TextStyle(color: Colors.blue), // Add this line
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ... Keep your existing MyApp and other classes unchanged.
```

Remember to fill in the functionality for the 'Forgot your password?' link and the 'Create a new account' button. Also, ensure that the `_buildDarkTheme()` function is either accessible within this file or imported if it's defined elsewhere.

The `_buildDarkTheme()` function you've already defined in your main file should be sufficient, but you may need to customize it further to match the exact colors and styles from the screenshot. Adjust colors, paddings, and other UI elements as needed to get the closest match to the provided design.


ok now we need the back button to work as well as the eye icon to show password
