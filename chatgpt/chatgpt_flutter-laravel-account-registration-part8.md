
Certainly! Here's the full code for the signup page in Flutter, including the registration and login process with error handling and token storage:

```dart
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/auth.dart';
import 'package:flutter/gestures.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:superheromobile/theme.dart'; // Ensure you have a theme.dart for styling

class CreateAccountPage extends StatefulWidget {
  @override
  _CreateAccountPageState createState() => _CreateAccountPageState();
}

class _CreateAccountPageState extends State<CreateAccountPage> {
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  bool _isLoading = false;
  bool _isPasswordVisible = false;
  bool _agreedToTerms = false;

  bool _isButtonEnabled() {
    return emailController.text.isNotEmpty &&
        passwordController.text.isNotEmpty &&
        _agreedToTerms;
  }

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
    setState(() {});
  }

  void _launchURL(String url) async {
    if (await canLaunch(url)) {
      await launch(url);
    } else {
      throw 'Could not launch $url';
    }
  }

  Future<void> registerAndLogin(BuildContext context) async {
    if (!_validateInputs()) {
      return;
    }

    setState(() {
      _isLoading = true;
    });

    String email = emailController.text;
    String password = passwordController.text;

    try {
      // Registration Request
      var registerResponse = await http.post(
        Uri.parse('https://superheromode.com/api/register'),
        headers: <String, String>{
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: json.encode({
          'email': email,
          'password': password,
        }),
      );

      if (registerResponse.statusCode == 200) {
        // Login Request
        var loginResponse = await http.post(
          Uri.parse('https://superheromode.com/api/login'),
          headers: <String, String>{
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: json.encode({
            'email': email,
            'password': password,
          }),
        );

        if (loginResponse.statusCode == 200) {
          var jsonResponse = json.decode(loginResponse.body);
          String token = jsonResponse['token'];

          // Securely store the token for future use
          final storage = FlutterSecureStorage();
          await storage.write(key: 'authToken', value: token);

          Provider.of<AuthModel>(context, listen: false).login();

          // Navigate to home screen
          Navigator.pushNamed(context, '/home');
        } else {
          // Handle login error
          var jsonResponse = json.decode(loginResponse.body);
          _showSnackBar(context, jsonResponse['message'] ?? 'Login failed. Please try again.');
        }
      } else {
        // Handle registration error
        var jsonResponse = json.decode(registerResponse.body);
        _showSnackBar(context, jsonResponse['message'] ?? 'Registration failed. Please try again.');
      }
    } catch (e) {
      _showSnackBar(context, 'An error occurred: ${e.toString()}');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  bool _validateInputs() {
    if (emailController.text.isEmpty ||
        passwordController.text.isEmpty ||
        !_agreedToTerms) {
      _showSnackBar(context, 'Please fill all fields and agree to the terms.');
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
    return Theme(
      data: buildDarkTheme(), // Make sure you have a DarkTheme
      child: Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          centerTitle: true,
          leading: IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ),
        body: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Center(
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Create Your Account',
                          style: TextStyle(
                            fontSize: 38,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        SizedBox(height: 16),
                        TextFormField(
                          controller: emailController,
                          decoration: InputDecoration(
                            labelText: 'What is your email?',
                            filled: true,
                            fillColor: Colors.grey[850],
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8.0),
                            ),
                          ),
                          keyboardType: TextInputType.emailAddress,
                          style: TextStyle(color: Colors.white),
                        ),
                        SizedBox(height: 16),
                        TextFormField(
                          controller: passwordController,
                          decoration: InputDecoration(
                            labelText: 'Choose a password',
                            filled: true,
                            fillColor: Colors.grey[850],
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(8.0),
                            ),
                            suffixIcon: IconButton(
                              icon: Icon(
                                _isPasswordVisible
                                    ? Icons.visibility_off
                                    : Icons.visibility,
                                color: Colors.white,
                              ),
                              onPressed: () {
                                setState(() {
                                  _isPasswordVisible = !_isPasswordVisible;
                                });
                              },
                            ),
                          ),
                          obscureText: !_isPasswordVisible,
                          style: TextStyle(color: Colors.white),
                        ),
                        SizedBox(height: 16),
                        Row(
                          children: [
                            Checkbox(
                              value: _agreedToTerms,
                              onChanged: (bool? newValue) {
                                setState(() {
                                  _agreedToTerms = newValue ?? false;
                                });
                              },
                            ),
                            Expanded(
                              child: RichText(
                                text: TextSpan(
                                  style: TextStyle(color: Colors.grey),
                                  children: <TextSpan>[
                                    TextSpan(text: 'I agree to the '),
                                    TextSpan(
                                      text: 'Privacy Policy',
                                      style: TextStyle(color: Colors.blue),
                                      recognizer: TapGestureRecognizer()
                                        ..onTap = () {
                                          _launchURL('https://a7x3.com/policies/privacy-policy');
                                        },
                                    ),
                                    TextSpan(text: ' and '),
                                    TextSpan(
                                      text: 'Terms of Service',
                                      style: TextStyle(color: Colors.blue),
                                      recognizer: TapGestureRecognizer()
                                        ..onTap = () {
                                          _launchURL('https://a7x3.com/policies/terms-of-service');
                                        },
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),



              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _isLoading
                      ? CircularProgressIndicator()
                      : SizedBox(
                          height: 48,
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: _isButtonEnabled()
                                ? () => registerAndLogin(context)
                                : null,
                            style: ButtonStyle(
                              backgroundColor:
                                  MaterialStateProperty.resolveWith<Color>(
                                      (Set<MaterialState> states) {
                                if (_isButtonEnabled()) {
                                  return Colors.white;
                                }
                                return Colors.white.withOpacity(0.5);
                              }),
                              foregroundColor:
                                  MaterialStateProperty.resolveWith<Color>(
                                      (Set<MaterialState> states) {
                                if (_isButtonEnabled()) {
                                  return Colors.black;
                                }
                                return Colors.grey;
                              }),
                              shape: MaterialStateProperty.all<
                                  RoundedRectangleBorder>(
                                RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(8.0),
                                ),
                              ),
                            ),
                            child: Text(
                              'Continue',
                              style: TextStyle(fontSize: 18),
                            ),
                          ),
                        ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

This code provides a complete signup page with registration and automatic login functionality. It includes UI elements for email and password input, a checkbox for agreeing to terms, and a button to submit the form. The `_isLoading` flag is used to show a loading indicator while the registration and login requests are processed. Error messages are displayed using a snackbar. The code also handles storing the authentication token securely using `FlutterSecureStorage`.


lutter: Status code: 200
flutter: Response body: {"success":true,"token":"8|8jafYxMOpaSElFaoWz0MBQMXjTOa7sCaitY9zKizb295de33"}
Another exception was thrown: Bad state: No element
flutter: Status code: 302
flutter: Response body: <!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="refresh" content="0;url='https://superheromode.com'" />

        <title>Redirecting to https://superheromode.com</title>
    </head>
    <body>
        Redirecting to <a href="https://superheromode.com">https://superheromode.com</a>.
    </body>
</html>
flutter: Status code: 200
flutter: Response body: {"success":true,"token":"9|tSRBV037zBj9Km0aGMPt0YVXo5AycuKqYKJRlaIY00bb6114"}
Another exception was thrown: Bad state: No element

Performing hot reload...                                                
Reloaded 2 of 1140 libraries in 437ms (compile: 78 ms, reload: 156 ms, reassemble: 71 ms).

lib/screens/signup_page.dart:153:8: Error: '_showSnackBar' is already declared in this scope.
  void _showSnackBar(BuildContext context, String message) {
       ^^^^^^^^^^^^^
lib/screens/signup_page.dart:135:8: Context: Previous declaration of '_showSnackBar'.
  void _showSnackBar(BuildContext context, String message) {
       ^^^^^^^^^^^^^
lib/screens/signup_page.dart:115:11: Error: Can't use '_showSnackBar' because it is declared more than once.
          _showSnackBar(context,
          ^
lib/screens/signup_page.dart:121:9: Error: Can't use '_showSnackBar' because it is declared more than once.
        _showSnackBar(
        ^
lib/screens/signup_page.dart:127:7: Error: Can't use '_showSnackBar' because it is declared more than once.
      _showSnackBar(context, 'An error occurred: ${e.toString()}');
      ^
lib/screens/signup_page.dart:147:7: Error: Can't use '_showSnackBar' because it is declared more than once.
      _showSnackBar(context, 'Please fill all fields and agree to the terms.');
      ^
lib/screens/signup_page.dart:291:41: Error: The method 'registerAccount' isn't defined for the class '_CreateAccountPageState'.
 - '_CreateAccountPageState' is from 'package:superheromobile/screens/signup_page.dart' ('lib/screens/signup_page.dart').
Try correcting the name to the name of an existing method, or defining a method named 'registerAccount'.
                                ? () => registerAccount(context)
                                        ^^^^^^^^^^^^^^^


The error messages you're seeing indicate a few issues in your Flutter code:

1. **Duplicate Declaration of `_showSnackBar` Method**: It seems you have declared the `_showSnackBar` method multiple times in your `signup_page.dart`. You should have only one declaration of this method in your class `_CreateAccountPageState`.

2. **Undefined Method `registerAccount`**: The method `registerAccount` is called, but it is not defined in your class. It looks like the method you should be calling is `registerAndLogin` based on the provided code.

3. **Exceptions Related to 'Bad state: No element'**: This error typically indicates an issue with accessing an element from a list or collection that does not exist. It's likely occurring in a different part of your code, possibly related to how you're handling the user state or navigation.

To resolve these issues, you should:

- Ensure that `_showSnackBar` is defined only once in `_CreateAccountPageState`.
- Replace `registerAccount(context)` with `registerAndLogin(context)` in your `ElevatedButton` onPressed callback.
- Investigate the part of your code that throws the 'Bad state: No element' exception. This error might be related to how you handle the user state after logging in. Check if you're trying to access a list or collection element that might be null or not available.

Here's a corrected snippet for the ElevatedButton's onPressed callback:

```dart
ElevatedButton(
  onPressed: _isButtonEnabled()
      ? () => registerAndLogin(context)  // Corrected method name
      : null,
  // Rest of the button styling and text...
),
```

For the 'Bad state: No element' error, you'll need to trace where this error is coming from. Check your user state management or any list/collection access that happens after login. If you're using a list or accessing an index of a list, ensure that the element exists before trying to access it.




══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════════════════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 2.0 pixels on the bottom.

The relevant error-causing widget was:
  Column
  Column:file:///Users/timwhite/Documents/GitHub/SuperheroModeMobile/superheromobile/lib/screens/home.dart:128:16

To inspect this widget in Flutter DevTools, visit:
http://127.0.0.1:9101/#/inspector?uri=http%3A%2F%2F127.0.0.1%3A59431%2Fa6EgfDcHke8%3D%2F&inspectorRef=inspector-35

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the rendering with a yellow and
black striped pattern. This is usually caused by the contents being too big for the RenderFlex.
Consider applying a flex factor (e.g. using an Expanded widget) to force the children of the
RenderFlex to fit within the available space instead of being sized to their natural size.
This is considered an error condition because it indicates that there is content that cannot be
seen. If the content is legitimately bigger than the available space, consider clipping it with a
ClipRect widget before putting it in the flex, or using a scrollable container rather than a Flex,
like a ListView.
The specific RenderFlex in question is: RenderFlex#50e94 relayoutBoundary=up2 OVERFLOWING:
  needs compositing
  creator: Column ← NotificationListener<OverscrollIndicatorNotification> ←
    NotificationListener<ScrollNotification> ← Stack ← RefreshIndicator ←
    KeyedSubtree-[GlobalKey#b5118] ← _BodyBuilder ← MediaQuery ← LayoutId-[<_ScaffoldSlot.body>] ←
    CustomMultiChildLayout ← _ActionsScope ← Actions ← ⋯
  parentData: not positioned; offset=Offset(0.0, 0.0) (can use size)
  constraints: BoxConstraints(0.0<=w<=390.0, 0.0<=h<=405.0)
  size: Size(390.0, 405.0)
  direction: vertical
  mainAxisAlignment: start
  mainAxisSize: max
  crossAxisAlignment: center
  verticalDirection: down
◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤
════════════════════════════════════════════════════════════════════════════════════════════════════

Performing hot reload...                                                
Reloaded 0 libraries in 191ms (compile: 15 ms, reload: 0 ms, reassemble: 105 ms).


The error message you're encountering, "A RenderFlex overflowed by 2.0 pixels on the bottom," is a common layout issue in Flutter. It occurs when a `Column` widget or another flex widget tries to render more content than the available space.

Here are steps to troubleshoot and fix this issue:

1. **Using `Expanded` or `Flexible` Widgets**: If your `Column` has multiple children and they don't all fit on the screen, you can wrap some of the children in an `Expanded` or `Flexible` widget. This tells Flutter to allocate the available space to these widgets, preventing overflow.

2. **Scrollable Widgets**: If your content is expected to exceed the screen size, consider wrapping your `Column` in a `SingleChildScrollView`. This makes your column scrollable, allowing users to scroll to view the entire content.

3. **Adjusting Size and Layout**: Sometimes, simply adjusting the size of the children widgets or their padding and margins can solve the overflow issue.

4. **Using `ClipRect`**: If you're certain that the overflowed content should not be visible or interactable, you can clip it using a `ClipRect` widget. However, this is less common and usually not recommended for solving layout issues.

5. **Debugging with Flutter DevTools**: The error message provides a link to Flutter DevTools for inspecting the widget. This can be very useful for understanding how your layout is being built and where the overflow is happening.

Here’s an example of using `SingleChildScrollView`:

```dart
SingleChildScrollView(
  child: Column(
    children: [
      // Your widgets here
    ],
  ),
)
```

Or using `Expanded`:

```dart
Column(
  children: [
    Expanded(
      child: WidgetThatShouldExpand(),
    ),
    AnotherWidget(),
  ],
)
```

You should adjust this according to the specific needs of your layout. Remember that while `Expanded` and `Flexible` can help distribute space within a flex container (`Column`, `Row`), `SingleChildScrollView` allows the content to be scrollable, which is useful if your content height exceeds the viewport height.


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
                    goalValue: 10000, // Example goal value
                    isGraphMode: true, // Enable bar graph mode
                    graphData: weeklySteps, // Pass the weekly steps data
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


below the bars can we show the date. we'll show it in the format of 1/1, 1/2, 1/3 etc and then for the  last 7 days we can write the day of the week abbreviated.


To add dates below the bars in your Flutter app, you can modify the `MetricDisplayComponent` to accept an additional parameter for the dates and display them accordingly. Since you're dealing with weekly steps data, you'll show the last seven days' dates.

Here's an approach to modify your `MetricDisplayComponent` and integrate it with your `MyHomePage`:

1. **Modify `MetricDisplayComponent`:** Add a parameter to accept a list of dates. You can use a list of strings for simplicity.

2. **Prepare Date Data in `MyHomePage`:** Generate a list of formatted date strings for the last seven days.

3. **Pass Date Data to `MetricDisplayComponent`:** When creating an instance of `MetricDisplayComponent`, pass the date data.

Here's an example of how you might implement this:

### Modified `MetricDisplayComponent`

```dart
class MetricDisplayComponent extends StatelessWidget {
  final String metricName;
  final double currentValue;
  final double goalValue;
  final bool isGraphMode;
  final List<double> graphData;
  final List<String> dateLabels; // Add this line

  const MetricDisplayComponent({
    Key? key,
    required this.metricName,
    required this.currentValue,
    required this.goalValue,
    required this.isGraphMode,
    required this.graphData,
    required this.dateLabels, // Add this line
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // ... existing code

    // Add UI component to display dates under the bars
    if (isGraphMode) {
      // Render the date labels
      return Column(
        children: [
          // ... existing graph rendering code

          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: dateLabels.map((date) => Text(date)).toList(),
          ),
        ],
      );
    } else {
      // ... existing non-graph mode code
    }
  }
}
```

### Preparing Date Data in `MyHomePage`

In `_fetchHealthData`, generate the date labels:

```dart
Future<void> _fetchHealthData() async {
  // ... existing code

  List<String> dateLabels = [];
  for (int i = 6; i >= 0; i--) {
    DateTime day = DateTime(endDate.year, endDate.month, endDate.day - i);
    String label = DateFormat('M/d').format(day); // Use 'E' for abbreviated weekday name
    if (i > 2) { // Adjust as needed
      label = DateFormat('E').format(day); // Show day of the week for recent days
    }
    dateLabels.add(label);
    // ... existing loop content
  }

  setState(() {
    this.weeklySteps = weeklyStepsTemp;
    this.dateLabels = dateLabels; // Add this line
    // ... other state updates
  });
}
```

### Passing Date Data to `MetricDisplayComponent`

When you create an instance of `MetricDisplayComponent` in your `MyHomePage` build method, pass the `dateLabels`:

```dart
MetricDisplayComponent(
  // ... other parameters
  dateLabels: dateLabels,
),
```

This approach will display dates below the bars in the format you specified. Remember to adjust logic according to your exact requirements and test thoroughly to ensure it behaves as expected.
