
{'asset_pointer': 'file-service://file-PUO9WUu6yWXRSTRdQwszTwhX', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': None, 'size_bytes': 87473, 'width': 946}
{'asset_pointer': 'file-service://file-linOYZ1CF5yZL3PJNJQ6cDtV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': None, 'size_bytes': 234411, 'width': 946}
{'asset_pointer': 'file-service://file-puUuBDpCCo2CU4NjG6agizUl', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': None, 'size_bytes': 85097, 'width': 946}
ok now we need to modify our login page so the button matches the screenshot (changing based on whether or not text is in the fields) and also the rest of the theme matches the screenshots.

heres our current code:
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:superheromobile/models/user.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/auth.dart';

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

class LoginPage extends StatefulWidget {
  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;
  bool _isPasswordVisible = false; // Add this line to track password visibility

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
    // Applying the dark theme to this page.
    return Theme(
      data: _buildDarkTheme(),
      child: Scaffold(
        appBar: AppBar(
          title: Text('Welcome back'),
          centerTitle: true, // Center the title
          leading: IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.of(context)
                .pop(), // Add this line to pop the current screen from the navigation stack
          ), // Adds a back button to the AppBar
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
                    border: OutlineInputBorder(
                      // Add this line
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
                    border: OutlineInputBorder(
                      // Add this line
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
                            shape: RoundedRectangleBorder(
                              // Add this line
                              borderRadius:
                                  BorderRadius.circular(8.0), // Add this line
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
}/* 
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
} */



Based on the screenshots you provided, here's how you can modify your login button to match the theme and include dynamic behavior based on whether the text fields are filled out.

Firstly, let's modify the `ElevatedButton` to match the styling. We'll also include logic to change its appearance based on whether the input fields are filled:

```dart
// Helper function to determine if the button should be enabled
bool _isButtonEnabled() {
  return emailController.text.isNotEmpty && passwordController.text.isNotEmpty;
}

// Your ElevatedButton with conditional styling
SizedBox(
  height: 48,
  width: double.infinity,
  child: ElevatedButton(
    onPressed: _isButtonEnabled() ? () => login(context) : null,
    style: ButtonStyle(
      backgroundColor: MaterialStateProperty.resolveWith<Color>((Set<MaterialState> states) {
        if (_isButtonEnabled()) {
          return Colors.white; // Button is enabled
        }
        return Colors.white.withOpacity(0.5); // Button is disabled
      }),
      foregroundColor: MaterialStateProperty.resolveWith<Color>((Set<MaterialState> states) {
        if (_isButtonEnabled()) {
          return Colors.black; // Text color when enabled
        }
        return Colors.grey; // Text color when disabled
      }),
      overlayColor: MaterialStateProperty.all(Colors.transparent), // No splash color
      shape: MaterialStateProperty.all<RoundedRectangleBorder>(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8.0),
        ),
      ),
      elevation: MaterialStateProperty.all(0), // No elevation
    ),
    child: Text(
      'Login',
      style: TextStyle(fontSize: 18),
    ),
  ),
),

// Add listeners to text fields to update the state of the button
@override
void initState() {
  super.initState();
  emailController.addListener(_updateButtonState);
  passwordController.addListener(_updateButtonState);
}

@override
void dispose() {
  emailController.removeListener(_updateButtonState);
  emailController.dispose();
  passwordController.removeListener(_updateButtonState);
  passwordController.dispose();
  super.dispose();
}

void _updateButtonState() {
  setState(() {}); // This will update the UI with the new button state
}
```

In the code above, `_isButtonEnabled` checks if both text fields are filled to enable the button and change its style to the active state. We added listeners to the `TextEditingController`s to call `setState` and rebuild our widget with the updated button style when the text changes.

For the rest of the theme to match the screenshots, you need to adjust the `ThemeData` to set the correct colors for the text, input fields, and the rest of the UI elements. If the screenshots show specific styles that are not covered in the existing theme, you would need to set those properties explicitly in your widgets or theme data. 

You also need to ensure that the `ElevatedButton` style changes are applied only to this button if you want to preserve different styles for other buttons in your app. If you want this style to apply to all buttons, you can set it in the global theme data.

Lastly, be sure to use the `Builder` widget or a similar approach to ensure that the button's enabled state is updated when the text fields are updated. This is because changing the text in a `TextFormField` will not automatically rebuild the `ElevatedButton` unless you explicitly call `setState` in the listeners.




lib/screens/login_page.dart:278:3: Error: Expected identifier, but got 'super'.
  super.initState();
  ^^^^^
lib/screens/login_page.dart:279:3: Error: Undefined name 'emailController'.
  emailController.addListener(_updateButtonState);
  ^^^^^^^^^^^^^^^
lib/screens/login_page.dart:280:3: Error: Undefined name 'passwordController'.
  passwordController.addListener(_updateButtonState);
  ^^^^^^^^^^^^^^^^^^
lib/screens/login_page.dart:285:3: Error: Undefined name 'emailController'.
  emailController.removeListener(_updateButtonState);
  ^^^^^^^^^^^^^^^
lib/screens/login_page.dart:286:3: Error: Undefined name 'emailController'.
  emailController.dispose();
  ^^^^^^^^^^^^^^^
lib/screens/login_page.dart:287:3: Error: Undefined name 'passwordController'.
  passwordController.removeListener(_updateButtonState);
  ^^^^^^^^^^^^^^^^^^
lib/screens/login_page.dart:288:3: Error: Undefined name 'passwordController'.
  passwordController.dispose();
  ^^^^^^^^^^^^^^^^^^
lib/screens/login_page.dart:289:3: Error: Expected identifier, but got 'super'.
  super.dispose();
  ^^^^^
lib/screens/login_page.dart:293:3: Error: Method not found: 'setState'.
  setState(() {}); // This will update the UI with the new button state
  ^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).



The errors you're encountering suggest that there are issues with the placement of the methods and potentially missing variables in your class. Let's correct the code and make sure everything is defined properly within your `State` class.

Here is how your `_LoginPageState` class should look with the added lifecycle methods (`initState` and `dispose`) and the listener setup for the text controllers:

```dart
class _LoginPageState extends State<LoginPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;
  bool _isPasswordVisible = false;

  @override
  void initState() {
    super.initState(); // Always call super.initState() first in initState method.
    emailController.addListener(_updateButtonState);
    passwordController.addListener(_updateButtonState);
  }

  @override
  void dispose() {
    emailController.removeListener(_updateButtonState);
    emailController.dispose();
    passwordController.removeListener(_updateButtonState);
    passwordController.dispose();
    super.dispose(); // Always call super.dispose() last in dispose method.
  }

  void _updateButtonState() {
    setState(() {
      // This will update the UI with the new button state
    });
  }

  // ... rest of your code for the login page
}
```

Ensure that the methods `initState` and `dispose` are included within your state class. The `super.initState()` and `super.dispose()` calls are part of the `State` class's lifecycle and must be included.

The `setState` method is used to notify the framework that the internal state of this object has changed in a way that might impact the user interface in this subtree, which causes the framework to schedule a build for this `State` object.

If your text controllers (`emailController` and `passwordController`) are still not recognized, make sure they are declared within the `_LoginPageState` class, not outside of it.

If you continue to experience issues, please review the structure of your Flutter application to ensure that all methods and variables are correctly defined within the appropriate scope.


great now we need to fix the show password button


To implement a "Show Password" toggle within a `TextFormField`, you'll want to update the `obscureText` property of the password field when the user taps the icon. The `_isPasswordVisible` flag can be used for this purpose. Here's how to integrate this functionality:

Firstly, make sure you have the `_isPasswordVisible` variable in your `_LoginPageState` class, which you already have based on your previous message.

Next, update the `TextFormField` for the password to use this flag, and toggle it when the "Show" button is pressed:

```dart
TextFormField(
  controller: passwordController,
  decoration: InputDecoration(
    labelText: 'Password',
    filled: true,
    fillColor: Colors.grey[850],
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8.0),
    ),
    suffixIcon: IconButton(
      icon: Icon(
        // Change the icon based on whether the password is visible or not
        _isPasswordVisible ? Icons.visibility_off : Icons.visibility,
        color: Colors.white,
      ),
      onPressed: () {
        // Update the password visibility state
        setState(() {
          _isPasswordVisible = !_isPasswordVisible;
        });
      },
    ),
  ),
  obscureText: !_isPasswordVisible, // Use the flag to determine text visibility
  style: TextStyle(color: Colors.white),
)
```

With this code, tapping the icon will toggle the visibility of the password and change the icon accordingly. The visibility state is managed by the `_isPasswordVisible` flag, which is toggled in the `onPressed` callback of the `IconButton`.

This should provide the "Show Password" functionality you're looking for. Make sure to test it to ensure it works as expected within your application.


ok great.

except now the border when active for the fields is purple. and the loader is purple. they should both be white


To change the active border color of the `TextFormField` and the color of the `CircularProgressIndicator` to white, you need to adjust your theme data.

For the input fields, you need to set the `focusedBorder` property in `inputDecorationTheme`. For the `CircularProgressIndicator`, you can wrap it with a `Theme` widget to override the color.

Here is how you can adjust your theme data:

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
      focusedBorder: OutlineInputBorder( // Add this line
        borderRadius: BorderRadius.circular(8.0),
        borderSide: BorderSide(color: Colors.white), // Set the color as needed
      ),
      // other decoration properties
    ),
    // Add color to the progress indicator within the theme
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: Colors.white, // Set the color as needed
    ),
    // other theme properties
  );
}
```

And when you use the `CircularProgressIndicator`, you don't need to wrap it with a `Theme` widget because you've set the color in the theme data. If you want to wrap it for a specific instance, here's how you can do it:

```dart
Theme(
  data: Theme.of(context).copyWith(
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: Colors.white,
    ),
  ),
  child: CircularProgressIndicator(),
)
```

By setting the `focusedBorder` in the `InputDecorationTheme` and the `progressIndicatorTheme`, you can achieve a consistent white color for the active borders and the loader across your application. If you only want to change these styles for specific widgets, you can apply these properties directly to the widget's constructor instead of the global theme.


heres my main page

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
        scaffoldBackgroundColor: Colors.black,
        // Set background color to black
      ),
      routes: {
        '/login': (context) => LoginPage(),
        // ... other routes
      },

      home: isLoggedIn ? MyHomePage(title: 'A7X3') : WelcomeScreen(),
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


how do i adjust it so the whole app uses this new theme


To apply the custom dark theme across your entire Flutter application, you should set the `darkTheme` property of your `MaterialApp` to the `ThemeData` instance returned by your `_buildDarkTheme()` function. Additionally, since you want to use the dark theme regardless of the system preference, you should set `themeMode` to `ThemeMode.dark`.

Here's how you should adjust your `MyApp` widget to apply the dark theme:

```dart
class MyApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final isLoggedIn = Provider.of<AuthModel>(context).isLoggedIn;

    return MaterialApp(
      title: 'A7X3',
      themeMode: ThemeMode.dark, // Always use the dark mode regardless of system preference.
      darkTheme: _buildDarkTheme(), // Use the custom dark theme
      home: isLoggedIn ? MyHomePage(title: 'A7X3') : WelcomeScreen(),
      // ... rest of your MaterialApp properties
    );
  }
}
```

In the `_buildDarkTheme()` function, to address the issue of the active border color and the loader color, you can use the `inputDecorationTheme` to customize the focused border of input fields and `progressIndicatorTheme` for the loader. Here's how to set these properties within your theme data:

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
      focusedBorder: OutlineInputBorder( // Customizing the focused border color
        borderRadius: BorderRadius.circular(8.0),
        borderSide: BorderSide(color: Colors.white),
      ),
      // other decoration properties
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: Colors.white, // Customizing the loader color
    ),
    // other theme properties
  );
}
```

With these changes, the entire app should now be using the custom dark theme you've defined. Make sure that the theme is consistently applied to all screens by not overriding the theme locally unless necessary. If you have other widgets that use their own theme, you may need to remove or adjust those local theme customizations to ensure consistency across the app.


                              
Reloaded 1 of 1113 libraries in 324ms (compile: 69 ms, reload: 121 ms, reassemble: 69 ms).

lib/main.dart:56:18: Error: The method '_buildDarkTheme' isn't defined for the class 'MyApp'.
 - 'MyApp' is from 'package:superheromobile/main.dart' ('lib/main.dart').
Try correcting the name to the name of an existing method, or defining a method named '_buildDarkTheme'.
      darkTheme: _buildDarkTheme(), // Use the custom dark theme
                 ^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).



**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_asset-loading-error-resolution-part1]]
- [[chatgpt/chatgpt_asset-loading-error-resolution-part2]]
- [[chatgpt/chatgpt_asset-loading-error-resolution-part4]]
- [[chatgpt/chatgpt_asset-loading-error-resolution-part5]]
- [[chatgpt/chatgpt_ci-error-resolution-prompt]]
