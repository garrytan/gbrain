
hows this       builder: (context, child) {
        // No longer throws
        return Text(context.watch<Example>().toString());
      }
    );
  }
  ```

If none of these solutions work, consider asking for help on StackOverflow:
https://stackoverflow.com/questions/tagged/flutter

#0      Provider._inheritedElementOf (package:provider/src/provider.dart:343:7)
#1      Provider.of (package:provider/src/provider.dart:293:30)
#2      LoginPage.login (package:superheromobile/login_page.dart:42:18)
<asynchronous suspension>

Performing hot reload...                                                
Reloaded 2 of 1109 libraries in 232ms (compile: 26 ms, reload: 105 ms, reassemble: 69 ms).

Performing hot reload...                                                
Reloaded 1 of 1109 libraries in 240ms (compile: 29 ms, reload: 110 ms, reassemble: 57 ms).

Performing hot reload...                                                
Reloaded 1 of 1109 libraries in 233ms (compile: 34 ms, reload: 106 ms, reassemble: 58 ms).

Performing hot restart...                                               
Restarted application in 771ms.

══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY
╞═══════════════════════════════════════════════════════════
The following ProviderNotFoundException was thrown building MyHomePage(dirty, state:
_MyHomePageState#7c562):
Error: Could not find the correct Provider<UserModel> above this MyHomePage Widget

This happens because you used a `BuildContext` that does not include the provider
of your choice. There are a few common scenarios:

- You added a new provider in your `main.dart` and performed a hot-reload.
  To fix, perform a hot-restart.

- The provider you are trying to read is in a different route.

  Providers are "scoped". So if you insert of provider inside a route, then
  other routes will not be able to access that provider.

- You used a `BuildContext` that is an ancestor of the provider you are trying to read.

  Make sure that MyHomePage is under your MultiProvider/Provider<UserModel>.
  This usually happens when you are creating a provider and trying to read it immediately.

  For example, instead of:

  ```
  Widget build(BuildContext context) {
    return Provider<Example>(
      create: (_) => Example(),
      // Will throw a ProviderNotFoundError, because `context` is associated
      // to the widget that is the parent of `Provider<Example>`
      child: Text(context.watch<Example>().toString()),
    );
  }
  ```

  consider using `builder` like so:

  ```
  Widget build(BuildContext context) {
    return Provider<Example>(
      create: (_) => Example(),
      // we use `builder` to obtain a new `BuildContext` that has access to the provider
      builder: (context, child) {
        // No longer throws
        return Text(context.watch<Example>().toString());
      }
    );
  }
  ```

If none of these solutions work, consider asking for help on StackOverflow:
https://stackoverflow.com/questions/tagged/flutter

The relevant error-causing widget was:
  MyHomePage
  MyHomePage:file:///Users/timwhite/Documents/GitHub/SuperheroModeMobile/superheromobile/lib/
  main.dart:46:19

When the exception was thrown, this was the stack:
#0      Provider._inheritedElementOf (package:provider/src/provider.dart:343:7)
#1      Provider.of (package:provider/src/provider.dart:293:30)
#2      _MyHomePageState.build (package:superheromobile/main.dart:166:27)
#3      StatefulElement.build (package:flutter/src/widgets/framework.dart:5583:27)
#4      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5471:15)
#5      StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#6      Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#7      ComponentElement._firstBuild (package:flutter/src/widgets/framework.dart:5453:5)
#8      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5625:11)
#9      ComponentElement.mount (package:flutter/src/widgets/framework.dart:5447:5)
...     Normal element mounting (24 frames)
#33     Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#34     MultiChildRenderObjectElement.inflateWidget
(package:flutter/src/widgets/framework.dart:6871:36)
#35     MultiChildRenderObjectElement.mount
(package:flutter/src/widgets/framework.dart:6883:32)
...     Normal element mounting (178 frames)
#213    Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#214    MultiChildRenderObjectElement.inflateWidget
(package:flutter/src/widgets/framework.dart:6871:36)
#215    MultiChildRenderObjectElement.mount
(package:flutter/src/widgets/framework.dart:6883:32)
...     Normal element mounting (484 frames)
#699    _InheritedProviderScopeElement.mount
(package:provider/src/inherited_provider.dart:411:11)
...     Normal element mounting (7 frames)
#706    SingleChildWidgetElementMixin.mount (package:nested/nested.dart:222:11)
...     Normal element mounting (27 frames)
#733    Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#734    Element.updateChild (package:flutter/src/widgets/framework.dart:3837:18)
#735    _RawViewElement._updateChild (package:flutter/src/widgets/view.dart:289:16)
#736    _RawViewElement.mount (package:flutter/src/widgets/view.dart:312:5)
...     Normal element mounting (7 frames)
#743    Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#744    Element.updateChild (package:flutter/src/widgets/framework.dart:3837:18)
#745    RootElement._rebuild (package:flutter/src/widgets/binding.dart:1334:16)
#746    RootElement.mount (package:flutter/src/widgets/binding.dart:1303:5)
#747    RootWidget.attach.<anonymous closure>
(package:flutter/src/widgets/binding.dart:1256:18)
#748    BuildOwner.buildScope (package:flutter/src/widgets/framework.dart:2835:19)
#749    RootWidget.attach (package:flutter/src/widgets/binding.dart:1255:13)
#750    WidgetsBinding.attachToBuildOwner (package:flutter/src/widgets/binding.dart:1083:27)
#751    WidgetsBinding.attachRootWidget (package:flutter/src/widgets/binding.dart:1065:5)
#752    WidgetsBinding.scheduleAttachRootWidget.<anonymous closure>
(package:flutter/src/widgets/binding.dart:1051:7)
#756    _RawReceivePort._handleMessage (dart:isolate-patch/isolate_patch.dart:184:12)
(elided 3 frames from class _Timer and dart:async-patch)

═════════════════════════════════════════════════════════════════════════════════════════════
═══════

Another exception was thrown: Error: Could not find the correct Provider<UserModel> above
this MyHomePage Widget

Performing hot restart...                                               
Restarted application in 728ms.
Lost connection to device.
timwhite@tims-air superheromobile % flutter run
Launching lib/main.dart on @timwhite in debug mode...
Automatically signing iOS for device deployment using specified development team in Xcode
project: G24T327LXT
Running Xcode build...                                                  
 └─Compiling, linking and signing...                      2,665ms
Xcode build done.                                           10.3s
You may be prompted to give access to control Xcode. Flutter uses Xcode to run your app. If
access is not allowed, you can change this through your Settings > Privacy & Security >
Automation.
[ERROR:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(42)] Using the Impeller rendering backend.
Installing and launching...                                        23.9s
Syncing files to device @timwhite...                                63ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
h List all available interactive commands.
d Detach (terminate "flutter run" but leave application running).
c Clear the screen
q Quit (terminate the application on the device).

A Dart VM Service on @timwhite is available at: http://127.0.0.1:49492/_CUrv2y4olc=/
The Flutter DevTools debugger and profiler on @timwhite is available at:
http://127.0.0.1:9102?uri=http://127.0.0.1:49492/_CUrv2y4olc=/
flutter: Error fetching user details: type 'String' is not a subtype of type 'double?'
flutter: Error fetching user details: type 'String' is not a subtype of type 'double?'

Performing hot restart...                                               
Restarted application in 742ms.

Performing hot restart...                                               
Restarted application in 640ms.
Lost connection to device.
timwhite@tims-air superheromobile % flutter run
Launching lib/main.dart on @timwhite in debug mode...
Automatically signing iOS for device deployment using specified development team in Xcode
project: G24T327LXT
Running Xcode build...                                                  
 └─Compiling, linking and signing...                      1,747ms
Xcode build done.                                            8.7s
You may be prompted to give access to control Xcode. Flutter uses Xcode to run your app. If
access is not allowed, you can change this through your Settings > Privacy & Security >
Automation.
[ERROR:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(42)] Using the Impeller rendering backend.
Installing and launching...                                        22.6s
Syncing files to device @timwhite...                                42ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
h List all available interactive commands.
d Detach (terminate "flutter run" but leave application running).
c Clear the screen
q Quit (terminate the application on the device).

A Dart VM Service on @timwhite is available at: http://127.0.0.1:49650/5aAHt0FkvLA=/
The Flutter DevTools debugger and profiler on @timwhite is available at:
http://127.0.0.1:9102?uri=http://127.0.0.1:49650/5aAHt0FkvLA=/
flutter: Error fetching user details: type 'int' is not a subtype of type 'String'

Performing hot restart...                                               
Restarted application in 647ms.

Performing hot reload...                                                
Reloaded 4 of 1108 libraries in 253ms (compile: 72 ms, reload: 79 ms, reassemble: 45 ms).
Lost connection to device.
timwhite@tims-air superheromobile % flutter run
Launching lib/main.dart on @timwhite in debug mode...
Automatically signing iOS for device deployment using specified development team in Xcode
project: G24T327LXT
Running Xcode build...                                                  
 └─Compiling, linking and signing...                      1,820ms
Xcode build done.                                            8.3s
You may be prompted to give access to control Xcode. Flutter uses Xcode to run your app. If
access is not allowed, you can change this through your Settings > Privacy & Security >
Automation.
[ERROR:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(42)] Using the Impeller rendering backend.
Installing and launching...                                        21.4s
Syncing files to device @timwhite...                                43ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
h List all available interactive commands.
d Detach (terminate "flutter run" but leave application running).
c Clear the screen
q Quit (terminate the application on the device).

A Dart VM Service on @timwhite is available at: http://127.0.0.1:49958/L_lCPdgA-gw=/
The Flutter DevTools debugger and profiler on @timwhite is available at:
http://127.0.0.1:9102?uri=http://127.0.0.1:49958/L_lCPdgA-gw=/
flutter: Error fetching user details: type 'int' is not a subtype of type 'String'
flutter: Error fetching user details: type 'int' is not a subtype of type 'String'

══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY
╞═════════════════════════════════════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 63 pixels on the bottom.

The relevant error-causing widget was:
  Column
  Column:file:///Users/timwhite/Documents/GitHub/SuperheroModeMobile/superheromobile/lib/logi
  n_page.dart:109:16

To inspect this widget in Flutter DevTools, visit:
http://127.0.0.1:9102/#/inspector?uri=http%3A%2F%2F127.0.0.1%3A49958%2FL_lCPdgA-gw%3D%2F&insp
ectorRef=inspector-0

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the rendering with a yellow
and
black striped pattern. This is usually caused by the contents being too big for the
RenderFlex.
Consider applying a flex factor (e.g. using an Expanded widget) to force the children of the
RenderFlex to fit within the available space instead of being sized to their natural size.
This is considered an error condition because it indicates that there is content that cannot
be
seen. If the content is legitimately bigger than the available space, consider clipping it
with a
ClipRect widget before putting it in the flex, or using a scrollable container rather than a
Flex,
like a ListView.
The specific RenderFlex in question is: RenderFlex#98519 relayoutBoundary=up2 OVERFLOWING:
  needs compositing
  creator: Column ← Center ← KeyedSubtree-[GlobalKey#e1894] ← _BodyBuilder ← MediaQuery ←
    LayoutId-[<_ScaffoldSlot.body>] ← CustomMultiChildLayout ← _ActionsScope ← Actions ←
    AnimatedBuilder ← DefaultTextStyle ← AnimatedDefaultTextStyle ← ⋯
  parentData: offset=Offset(0.0, 0.0) (can use size)
  constraints: BoxConstraints(0.0<=w<=844.0, 0.0<=h<=115.0)
  size: Size(844.0, 115.0)
  direction: vertical
  mainAxisAlignment: center
  mainAxisSize: max
  crossAxisAlignment: center
  verticalDirection: down
◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢
◤◢◤◢◤◢◤
═════════════════════════════════════════════════════════════════════════════════════════════
═══════

flutter: Error fetching user details: type 'int' is not a subtype of type 'String'
flutter: Error fetching user details: type 'int' is not a subtype of type 'String'
flutter: Error fetching user details: type 'int' is not a subtype of type 'String'

Performing hot reload...                                                
Reloaded 4 of 1109 libraries in 279ms (compile: 43 ms, reload: 85 ms, reassemble: 60 ms).

Performing hot reload...                                                
Reloaded 4 of 1109 libraries in 231ms (compile: 39 ms, reload: 99 ms, reassemble: 50 ms).
Application finished.
the Dart compiler exited unexpectedly.
timwhite@tims-air superheromobile % flutter run
Launching lib/main.dart on @timwhite in debug mode...
Automatically signing iOS for device deployment using specified development team in Xcode
project: G24T327LXT
Running Xcode build...                                                  
 └─Compiling, linking and signing...                      1,625ms
Xcode build done.                                            8.1s
You may be prompted to give access to control Xcode. Flutter uses Xcode to run your app. If
access is not allowed, you can change this through your Settings > Privacy & Security >
Automation.
[ERROR:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(42)] Using the Impeller rendering backend.
Installing and launching...                                        22.0s
Syncing files to device @timwhite...                                68ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
h List all available interactive commands.
d Detach (terminate "flutter run" but leave application running).
c Clear the screen
q Quit (terminate the application on the device).

A Dart VM Service on @timwhite is available at: http://127.0.0.1:50122/y1M_HbGK6_8=/
The Flutter DevTools debugger and profiler on @timwhite is available at:
http://127.0.0.1:9102?uri=http://127.0.0.1:50122/y1M_HbGK6_8=/

lib/models/user.dart:14:11: Error: The name of a constructor must match the name of the
enclosing class.
  factory User.fromJson(Map<String, dynamic> json) {
          ^^^^
package:superheromobile/models/user.dart: Context: The name of the enclosing class is
'UserModel'.
lib/login_page.dart:67:10: Error: Type 'User' not found.
  Future<User?> fetchUserDetails(String token) async {
         ^^^^
lib/models/user.dart:3:25: Error: Type 'ChangeNotifier' not found.
class UserModel extends ChangeNotifier {
                        ^^^^^^^^^^^^^^
lib/user_provider.dart:5:3: Error: Type 'User' not found.
  User? _user;
  ^^^^
lib/user_provider.dart:7:3: Error: Type 'User' not found.
  User? get user => _user;
  ^^^^
lib/user_provider.dart:9:16: Error: Type 'User' not found.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:3:7: Error: The non-abstract class 'UserModel' is missing
implementations for these members:
 - UserModel.User
Try to either
 - provide an implementation,
 - inherit an implementation from a superclass or mixin,
 - mark the class as abstract, or
 - provide a 'noSuchMethod' implementation.

class UserModel extends ChangeNotifier {
      ^^^^^^^^^
lib/models/user.dart:8:3: Context: 'UserModel.User' is defined here.
  User({
  ^^^^
lib/main.dart:172:14: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
             ^^^^^^^^
lib/main.dart:172:52: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
                                                   ^^^^^^^^
lib/main.dart:174:26: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    bool isMetric = user.isMetric;
                         ^^^^^^^^
lib/main.dart:175:24: Error: The method 'calculateFFMI' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'calculateFFMI'.
    double ffmi = user.calculateFFMI();
                       ^^^^^^^^^^^^^
lib/main.dart:218:22: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                user.birthday != null
                     ^^^^^^^^
lib/main.dart:219:42: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                    ? _calculateAge(user.birthday!).toDouble()
                                         ^^^^^^^^
lib/main.dart:340:69: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;
                                                                    ^^^^^^^^
lib/main.dart:388:54: Error: The method 'updateBirthday' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateBirthday'.
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
                                                     ^^^^^^^^^^^^^^
lib/main.dart:411:27: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
              value: user.isMetric,
                          ^^^^^^^^
lib/main.dart:413:22: Error: The method 'toggleUnitPreference' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'toggleUnitPreference'.
                user.toggleUnitPreference();
                     ^^^^^^^^^^^^^^^^^^^^
lib/login_page.dart:48:9: Error: 'User' isn't a type.
        User? user = await fetchUserDetails(token);
        ^^^^
lib/login_page.dart:77:16: Error: The getter 'User' isn't defined for the class
'_LoginPageState'.
 - '_LoginPageState' is from 'package:superheromobile/login_page.dart'
 ('lib/login_page.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'User'.
        return User.fromJson(json.decode(response.body));
               ^^^^
lib/models/user.dart:9:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.id,
             ^^^^
lib/models/user.dart:10:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.name,
             ^^^^
lib/models/user.dart:11:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.email,
             ^^^^
lib/models/user.dart:15:12: Error: Method not found: 'User'.
    return User(
           ^^^^
lib/user_provider.dart:5:3: Error: 'User' isn't a type.
  User? _user;
  ^^^^
lib/user_provider.dart:9:16: Error: 'User' isn't a type.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:4:13: Error: Final field 'id' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final int id;
            ^^
lib/models/user.dart:5:16: Error: Final field 'name' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String name;
               ^^^^
lib/models/user.dart:6:16: Error: Final field 'email' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String email;
               ^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/models/user.dart:14:11: Error: The name of a constructor must match the name of the
enclosing class.
  factory User.fromJson(Map<String, dynamic> json) {
          ^^^^
package:superheromobile/models/user.dart: Context: The name of the enclosing class is
'UserModel'.
lib/login_page.dart:67:10: Error: Type 'User' not found.
  Future<User?> fetchUserDetails(String token) async {
         ^^^^
lib/models/user.dart:3:25: Error: Type 'ChangeNotifier' not found.
class UserModel extends ChangeNotifier {
                        ^^^^^^^^^^^^^^
lib/user_provider.dart:5:3: Error: Type 'User' not found.
  User? _user;
  ^^^^
lib/user_provider.dart:7:3: Error: Type 'User' not found.
  User? get user => _user;
  ^^^^
lib/user_provider.dart:9:16: Error: Type 'User' not found.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:3:7: Error: The non-abstract class 'UserModel' is missing
implementations for these members:
 - UserModel.User
Try to either
 - provide an implementation,
 - inherit an implementation from a superclass or mixin,
 - mark the class as abstract, or
 - provide a 'noSuchMethod' implementation.

class UserModel extends ChangeNotifier {
      ^^^^^^^^^
lib/models/user.dart:8:3: Context: 'UserModel.User' is defined here.
  User({
  ^^^^
lib/login_page.dart:48:9: Error: 'User' isn't a type.
        User? user = await fetchUserDetails(token);
        ^^^^
lib/login_page.dart:77:16: Error: The getter 'User' isn't defined for the class
'_LoginPageState'.
 - '_LoginPageState' is from 'package:superheromobile/login_page.dart'
 ('lib/login_page.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'User'.
        return User.fromJson(json.decode(response.body));
               ^^^^
lib/models/user.dart:9:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.id,
             ^^^^
lib/models/user.dart:10:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.name,
             ^^^^
lib/models/user.dart:11:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.email,
             ^^^^
lib/models/user.dart:15:12: Error: Method not found: 'User'.
    return User(
           ^^^^
lib/user_provider.dart:5:3: Error: 'User' isn't a type.
  User? _user;
  ^^^^
lib/user_provider.dart:9:16: Error: 'User' isn't a type.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:4:13: Error: Final field 'id' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final int id;
            ^^
lib/models/user.dart:5:16: Error: Final field 'name' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String name;
               ^^^^
lib/models/user.dart:6:16: Error: Final field 'email' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String email;
               ^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/models/user.dart:14:11: Error: The name of a constructor must match the name of the
enclosing class.
  factory User.fromJson(Map<String, dynamic> json) {
          ^^^^
package:superheromobile/models/user.dart: Context: The name of the enclosing class is
'UserModel'.
lib/login_page.dart:67:10: Error: Type 'User' not found.
  Future<User?> fetchUserDetails(String token) async {
         ^^^^
lib/models/user.dart:3:25: Error: Type 'ChangeNotifier' not found.
class UserModel extends ChangeNotifier {
                        ^^^^^^^^^^^^^^
lib/user_provider.dart:5:3: Error: Type 'User' not found.
  User? _user;
  ^^^^
lib/user_provider.dart:7:3: Error: Type 'User' not found.
  User? get user => _user;
  ^^^^
lib/user_provider.dart:9:16: Error: Type 'User' not found.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:3:7: Error: The non-abstract class 'UserModel' is missing
implementations for these members:
 - UserModel.User
Try to either
 - provide an implementation,
 - inherit an implementation from a superclass or mixin,
 - mark the class as abstract, or
 - provide a 'noSuchMethod' implementation.

class UserModel extends ChangeNotifier {
      ^^^^^^^^^
lib/models/user.dart:8:3: Context: 'UserModel.User' is defined here.
  User({
  ^^^^
lib/login_page.dart:48:9: Error: 'User' isn't a type.
        User? user = await fetchUserDetails(token);
        ^^^^
lib/login_page.dart:77:16: Error: The getter 'User' isn't defined for the class
'_LoginPageState'.
 - '_LoginPageState' is from 'package:superheromobile/login_page.dart'
 ('lib/login_page.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'User'.
        return User.fromJson(json.decode(response.body));
               ^^^^
lib/models/user.dart:9:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.id,
             ^^^^
lib/models/user.dart:10:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.name,
             ^^^^
lib/models/user.dart:11:14: Error: Field formal parameters can only be used in a constructor.
Try removing 'this.'.
    required this.email,
             ^^^^
lib/models/user.dart:15:12: Error: Method not found: 'User'.
    return User(
           ^^^^
lib/user_provider.dart:5:3: Error: 'User' isn't a type.
  User? _user;
  ^^^^
lib/user_provider.dart:9:16: Error: 'User' isn't a type.
  void setUser(User? user) {
               ^^^^
lib/models/user.dart:4:13: Error: Final field 'id' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final int id;
            ^^
lib/models/user.dart:5:16: Error: Final field 'name' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String name;
               ^^^^
lib/models/user.dart:6:16: Error: Final field 'email' is not initialized.
Try to initialize the field in the declaration or in every constructor.
  final String email;
               ^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/main.dart:171:14: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
             ^^^^^^^^
lib/main.dart:171:52: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
                                                   ^^^^^^^^
lib/main.dart:173:26: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    bool isMetric = user.isMetric;
                         ^^^^^^^^
lib/main.dart:174:24: Error: The method 'calculateFFMI' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'calculateFFMI'.
    double ffmi = user.calculateFFMI();
                       ^^^^^^^^^^^^^
lib/main.dart:217:22: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                user.birthday != null
                     ^^^^^^^^
lib/main.dart:218:42: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                    ? _calculateAge(user.birthday!).toDouble()
                                         ^^^^^^^^
lib/main.dart:339:69: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;
                                                                    ^^^^^^^^
lib/main.dart:387:54: Error: The method 'updateBirthday' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateBirthday'.
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
                                                     ^^^^^^^^^^^^^^
lib/main.dart:410:27: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
              value: user.isMetric,
                          ^^^^^^^^
lib/main.dart:412:22: Error: The method 'toggleUnitPreference' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'toggleUnitPreference'.
                user.toggleUnitPreference();
                     ^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/main.dart:171:14: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
             ^^^^^^^^
lib/main.dart:171:52: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
                                                   ^^^^^^^^
lib/main.dart:173:26: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    bool isMetric = user.isMetric;
                         ^^^^^^^^
lib/main.dart:174:24: Error: The method 'calculateFFMI' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'calculateFFMI'.
    double ffmi = user.calculateFFMI();
                       ^^^^^^^^^^^^^
lib/main.dart:217:22: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                user.birthday != null
                     ^^^^^^^^
lib/main.dart:218:42: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                    ? _calculateAge(user.birthday!).toDouble()
                                         ^^^^^^^^
lib/main.dart:339:69: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;
                                                                    ^^^^^^^^
lib/main.dart:387:54: Error: The method 'updateBirthday' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateBirthday'.
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
                                                     ^^^^^^^^^^^^^^
lib/main.dart:410:27: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
              value: user.isMetric,
                          ^^^^^^^^
lib/main.dart:412:22: Error: The method 'toggleUnitPreference' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'toggleUnitPreference'.
                user.toggleUnitPreference();
                     ^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/main.dart:171:14: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
             ^^^^^^^^
lib/main.dart:171:52: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
                                                   ^^^^^^^^
lib/main.dart:173:26: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    bool isMetric = user.isMetric;
                         ^^^^^^^^
lib/main.dart:174:24: Error: The method 'calculateFFMI' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'calculateFFMI'.
    double ffmi = user.calculateFFMI();
                       ^^^^^^^^^^^^^
lib/main.dart:217:22: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                user.birthday != null
                     ^^^^^^^^
lib/main.dart:218:42: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                    ? _calculateAge(user.birthday!).toDouble()
                                         ^^^^^^^^
lib/main.dart:339:69: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;
                                                                    ^^^^^^^^
lib/main.dart:387:54: Error: The method 'updateBirthday' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateBirthday'.
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
                                                     ^^^^^^^^^^^^^^
lib/main.dart:410:27: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
              value: user.isMetric,
                          ^^^^^^^^
lib/main.dart:412:22: Error: The method 'toggleUnitPreference' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'toggleUnitPreference'.
                user.toggleUnitPreference();
                     ^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).

lib/main.dart:171:14: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
             ^^^^^^^^
lib/main.dart:171:52: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
        user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;
                                                   ^^^^^^^^
lib/main.dart:173:26: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    bool isMetric = user.isMetric;
                         ^^^^^^^^
lib/main.dart:174:24: Error: The method 'calculateFFMI' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'calculateFFMI'.
    double ffmi = user.calculateFFMI();
                       ^^^^^^^^^^^^^
lib/main.dart:217:22: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                user.birthday != null
                     ^^^^^^^^
lib/main.dart:218:42: Error: The getter 'birthday' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'birthday'.
                    ? _calculateAge(user.birthday!).toDouble()
                                         ^^^^^^^^
lib/main.dart:339:69: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;
                                                                    ^^^^^^^^
lib/main.dart:387:54: Error: The method 'updateBirthday' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateBirthday'.
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
                                                     ^^^^^^^^^^^^^^
lib/main.dart:410:27: Error: The getter 'isMetric' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing getter, or defining a getter or field
named 'isMetric'.
              value: user.isMetric,
                          ^^^^^^^^
lib/main.dart:412:22: Error: The method 'toggleUnitPreference' isn't defined for the class
'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'toggleUnitPreference'.
                user.toggleUnitPreference();
                     ^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY
╞═══════════════════════════════════════════════════════════
The following ProviderNotFoundException was thrown building MyHomePage(dirty, dependencies:
[_InheritedProviderScope<UserModel?>], state: _MyHomePageState#e5bc7):
Error: Could not find the correct Provider<UserModel> above this MyHomePage Widget

This happens because you used a `BuildContext` that does not include the provider
of your choice. There are a few common scenarios:

- You added a new provider in your `main.dart` and performed a hot-reload.
  To fix, perform a hot-restart.

- The provider you are trying to read is in a different route.

  Providers are "scoped". So if you insert of provider inside a route, then
  other routes will not be able to access that provider.

- You used a `BuildContext` that is an ancestor of the provider you are trying to read.

  Make sure that MyHomePage is under your MultiProvider/Provider<UserModel>.
  This usually happens when you are creating a provider and trying to read it immediately.

  For example, instead of:

  ```
  Widget build(BuildContext context) {
    return Provider<Example>(
      create: (_) => Example(),
      // Will throw a ProviderNotFoundError, because `context` is associated
      // to the widget that is the parent of `Provider<Example>`
      child: Text(context.watch<Example>().toString()),
    );
  }
  ```

  consider using `builder` like so:

  ```
  Widget build(BuildContext context) {
    return Provider<Example>(
      create: (_) => Example(),
      // we use `builder` to obtain a new `BuildContext` that has access to the provider
      builder: (context, child) {
        // No longer throws
        return Text(context.watch<Example>().toString());
      }
    );
  }
  ```

If none of these solutions work, consider asking for help on StackOverflow:
https://stackoverflow.com/questions/tagged/flutter

The relevant error-causing widget was:
  MyHomePage
  MyHomePage:file:///Users/timwhite/Documents/GitHub/SuperheroModeMobile/superheromobile/lib/
  main.dart:49:19

When the exception was thrown, this was the stack:
#0      Provider._inheritedElementOf (package:provider/src/provider.dart:343:7)
#1      Provider.of (package:provider/src/provider.dart:293:30)
#2      _MyHomePageState.build (package:superheromobile/main.dart:169:27)
#3      StatefulElement.build (package:flutter/src/widgets/framework.dart:5583:27)
#4      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5471:15)
#5      StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#6      Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#7      BuildOwner.buildScope (package:flutter/src/widgets/framework.dart:2895:19)
#8      WidgetsBinding.drawFrame (package:flutter/src/widgets/binding.dart:984:21)
#9      RendererBinding._handlePersistentFrameCallback
(package:flutter/src/rendering/binding.dart:457:5)
#10     SchedulerBinding._invokeFrameCallback
(package:flutter/src/scheduler/binding.dart:1325:15)
#11     SchedulerBinding.handleDrawFrame (package:flutter/src/scheduler/binding.dart:1255:9)
#12     SchedulerBinding.scheduleWarmUpFrame.<anonymous closure>
(package:flutter/src/scheduler/binding.dart:978:7)
#16     _RawReceivePort._handleMessage (dart:isolate-patch/isolate_patch.dart:184:12)
(elided 3 frames from class _Timer and dart:async-patch)

═════════════════════════════════════════════════════════════════════════════════════════════
═══════

Performing hot reload...                                                
Reloaded 4 of 1109 libraries in 266ms (compile: 24 ms, reload: 85 ms, reassemble: 82 ms).
Application finished.
the Dart compiler exited unexpectedly.
timwhite@tims-air superheromobile % flutter run
Launching lib/main.dart on @timwhite in debug mode...
Automatically signing iOS for device deployment using specified development team in Xcode
project: G24T327LXT
Running Xcode build...                                                  
 └─Compiling, linking and signing...                      1,841ms
Xcode build done.                                            8.6s
You may be prompted to give access to control Xcode. Flutter uses Xcode to run your app. If
access is not allowed, you can change this through your Settings > Privacy & Security >
Automation.
[ERROR:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(42)] Using the Impeller rendering backend.
Installing and launching...                                        27.3s
Syncing files to device @timwhite...                                41ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
h List all available interactive commands.
d Detach (terminate "flutter run" but leave application running).
c Clear the screen
q Quit (terminate the application on the device).

A Dart VM Service on @timwhite is available at: http://127.0.0.1:50485/FMOaYDisDNQ=/
The Flutter DevTools debugger and profiler on @timwhite is available at:
http://127.0.0.1:9102?uri=http://127.0.0.1:50485/FMOaYDisDNQ=/

Performing hot reload...                                                
Reloaded 1 of 1109 libraries in 265ms (compile: 36 ms, reload: 83 ms, reassemble: 63 ms).

