
Reloaded 1 of 1140 libraries in 459ms (compile: 60 ms, reload: 144 ms, reassemble: 100 ms).
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
flutter: Response body: {"success":true,"token":"7|6WTj6NEFd6qMZMI3SqQ8LDKQCoY4xS7SS5xl89HAc8896493"}

══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══════════════════════════════════════════════════════════
The following StateError was thrown building MyHomePage(dirty, dependencies:
[_InheritedProviderScope<UserModel?>], state: _MyHomePageState#4128b):
Bad state: No element

The relevant error-causing widget was:
  MyHomePage
  MyHomePage:file:///Users/timwhite/Documents/GitHub/SuperheroModeMobile/superheromobile/lib/main.dart:63:31

When the exception was thrown, this was the stack:
#0      List.last (dart:core-patch/growable_array.dart:348:5)
#1      _MyHomePageState.build (package:superheromobile/screens/home.dart:158:26)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart:5583:27)
#3      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5471:15)
#4      StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#5      Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#6      ComponentElement._firstBuild (package:flutter/src/widgets/framework.dart:5453:5)
#7      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5625:11)
#8      ComponentElement.mount (package:flutter/src/widgets/framework.dart:5447:5)
...     Normal element mounting (24 frames)
#32     Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#33     MultiChildRenderObjectElement.inflateWidget (package:flutter/src/widgets/framework.dart:6871:36)
#34     MultiChildRenderObjectElement.mount (package:flutter/src/widgets/framework.dart:6883:32)
...     Normal element mounting (178 frames)
#212    Element.inflateWidget (package:flutter/src/widgets/framework.dart:4326:16)
#213    MultiChildRenderObjectElement.inflateWidget (package:flutter/src/widgets/framework.dart:6871:36)
#214    Element.updateChild (package:flutter/src/widgets/framework.dart:3837:18)
#215    Element.updateChildren (package:flutter/src/widgets/framework.dart:4024:32)
#216    MultiChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6896:17)
#217    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#218    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#219    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#220    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#221    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#222    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#223    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#224    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#225    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#226    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#227    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#228    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#229    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#230    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#231    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#232    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#233    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#234    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#235    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#236    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#237    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#238    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#239    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#240    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#241    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#242    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#243    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#244    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#245    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#246    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#247    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#248    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#249    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#250    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#251    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#252    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#253    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#254    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#255    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#256    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#257    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#258    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#259    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#260    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#261    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#262    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#263    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#264    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#265    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#266    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#267    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#268    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#269    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#270    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#271    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#272    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#273    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#274    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#275    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#276    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#277    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#278    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#279    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#280    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#281    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#282    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#283    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#284    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#285    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#286    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#287    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#288    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#289    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#290    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#291    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#292    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#293    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#294    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#295    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#296    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#297    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#298    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#299    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#300    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#301    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#302    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#303    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#304    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#305    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#306    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#307    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#308    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#309    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#310    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#311    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#312    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#313    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#314    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#315    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#316    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#317    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#318    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#319    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#320    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#321    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#322    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#323    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#324    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#325    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#326    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#327    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#328    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#329    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#330    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#331    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#332    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#333    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#334    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#335    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#336    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#337    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#338    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#339    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#340    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#341    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#342    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#343    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#344    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#345    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#346    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#347    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#348    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#349    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#350    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#351    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#352    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#353    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#354    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#355    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#356    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#357    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#358    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#359    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#360    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#361    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#362    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#363    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#364    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#365    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#366    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#367    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#368    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#369    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#370    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#371    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#372    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#373    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#374    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#375    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#376    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#377    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#378    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#379    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#380    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#381    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#382    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#383    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#384    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#385    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#386    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#387    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#388    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#389    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#390    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#391    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#392    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#393    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#394    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#395    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#396    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#397    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#398    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#399    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#400    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#401    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#402    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#403    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#404    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#405    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#406    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#407    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#408    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#409    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#410    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#411    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#412    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#413    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#414    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#415    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#416    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#417    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#418    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#419    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#420    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#421    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#422    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#423    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#424    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#425    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#426    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#427    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#428    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#429    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#430    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#431    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#432    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#433    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#434    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#435    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#436    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#437    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#438    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#439    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#440    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#441    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#442    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#443    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#444    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#445    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#446    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#447    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#448    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#449    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#450    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#451    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#452    StatelessElement.update (package:flutter/src/widgets/framework.dart:5547:5)
#453    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#454    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#455    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#456    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#457    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#458    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#459    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#460    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#461    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#462    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#463    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#464    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#465    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#466    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#467    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#468    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#469    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#470    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#471    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#472    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#473    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#474    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#475    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#476    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#477    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#478    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#479    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#480    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#481    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#482    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#483    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#484    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#485    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#486    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#487    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#488    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#489    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#490    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#491    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#492    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#493    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#494    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#495    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#496    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#497    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#498    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#499    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#500    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#501    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#502    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#503    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#504    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#505    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#506    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#507    SingleChildRenderObjectElement.update (package:flutter/src/widgets/framework.dart:6743:14)
#508    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#509    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#510    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#511    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#512    _InheritedNotifierElement.update (package:flutter/src/widgets/inherited_notifier.dart:105:11)
#513    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#514    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#515    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#516    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#517    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#518    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#519    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#520    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#521    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#522    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#523    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#524    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#525    ProxyElement.update (package:flutter/src/widgets/framework.dart:5800:5)
#526    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#527    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#528    StatefulElement.performRebuild (package:flutter/src/widgets/framework.dart:5634:11)
#529    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#530    StatefulElement.update (package:flutter/src/widgets/framework.dart:5657:5)
#531    Element.updateChild (package:flutter/src/widgets/framework.dart:3815:15)
#532    ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5496:16)
#533    Element.rebuild (package:flutter/src/widgets/framework.dart:5187:7)
#534    BuildOwner.buildScope (package:flutter/src/widgets/framework.dart:2895:19)
#535    WidgetsBinding.drawFrame (package:flutter/src/widgets/binding.dart:984:21)
#536    RendererBinding._handlePersistentFrameCallback (package:flutter/src/rendering/binding.dart:457:5)
#537    SchedulerBinding._invokeFrameCallback (package:flutter/src/scheduler/binding.dart:1325:15)
#538    SchedulerBinding.handleDrawFrame (package:flutter/src/scheduler/binding.dart:1255:9)
#539    SchedulerBinding._handleDrawFrame (package:flutter/src/scheduler/binding.dart:1113:5)
#540    _invoke (dart:ui/hooks.dart:312:13)
#541    PlatformDispatcher._drawFrame (dart:ui/platform_dispatcher.dart:383:5)
#542    _drawFrame (dart:ui/hooks.dart:283:31)

════════════════════════════════════════════════════════════════════════════════════════════════════




The output and exceptions you're encountering suggest a few potential issues in your Flutter app, especially with the navigation and state management after the registration process. Here are some steps to debug and resolve these issues:

1. **Handling HTTP Status Code 302**: The status code 302 indicates a redirect. Your Flutter app is receiving a redirect response from the server. This is unusual for an API call and might be indicative of a misconfiguration on the server side. Ensure that your API endpoint (`https://superheromode.com/api/register`) is correctly configured to handle POST requests for user registration and should return a JSON response, not a redirect.

2. **Proper JSON Parsing and Error Handling**: Ensure that the response from the server is correctly parsed. Check if the response is indeed a valid JSON with the expected fields (`success`, `token`).

3. **State Management and Navigation Issue**: The exception `Bad state: No element` suggests an issue with how you're managing the state or navigating in your app. This could be due to trying to access an element in a list or collection that doesn't exist. Review your `MyHomePage` and related state management logic. Ensure that the data you're trying to access is properly initialized and available.

4. **Check Provider and AuthModel Logic**: Verify that `Provider.of<AuthModel>(context, listen: false).login();` correctly updates the user's logged-in status. Ensure that `AuthModel` properly handles the authentication state and notifies its listeners.

5. **Review Navigation Logic**: Check your navigation logic after successful registration. If you're using `Navigator.pushNamed(context, '/home');`, ensure that the '/home' route is correctly defined and that the corresponding screen correctly handles the new state.

6. **Debugging**: Use debugging tools or print statements to check the flow of your code and the values of key variables at each step. This will help pinpoint where the issue lies - whether it's during the registration, state updating, or navigation.

7. **Flutter Hot Reload and State**: If you're heavily relying on Flutter's hot reload, sometimes the app state can behave unexpectedly. Try completely stopping the app and running it again instead of just hot reloading.

Addressing these points should help you resolve the issue. If the problem persists, it might be helpful to look into the specific implementation of your home screen and how it interacts with the user's authentication state.


i guess we need to actually make a login request? on the signup page on successful regirstation?




Yes, that's a common approach in many applications. After successfully registering a user, you would typically want to automatically log them in. This process involves two steps:

1. **Registration**: Your current registration endpoint (`/api/register`) creates a new user in the database. Upon successful registration, it returns a success message and a token.

2. **Automatic Login**: After registration, instead of just storing the token and navigating to the home screen, you should make a login request to your login endpoint (usually something like `/api/login`). This ensures that the user is properly logged in and their session is correctly established, especially if your login process involves additional steps like setting up a session or other user-specific data.

Here's how you can modify your Flutter code to handle this:

```dart
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
        // Handle token storage and navigate to home
        // ...
      } else {
        // Handle login error
        // ...
      }
    } else {
      // Handle registration error
      // ...
    }
  } catch (e) {
    // Handle exception
    // ...
  } finally {
    setState(() {
      _isLoading = false;
    });
  }
}
```

Make sure your API endpoints for registration and login are set up to handle these requests correctly. The login endpoint should authenticate the user and return a token that you can use for subsequent authenticated requests.


give me the full function code with error handling and token storage


Certainly, here's the full function code for registering and automatically logging in a user, including error handling and token storage. This function can be placed in your `_CreateAccountPageState` class in Flutter:

```dart
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

void _showSnackBar(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(message),
    ),
  );
}
```

This function performs the following steps:
1. Validates the inputs.
2. Sends a registration request.
3. If registration is successful, it sends a login request.
4. Handles successful login by storing the token and navigating to the home screen.
5. Provides feedback to the user in case of any errors during registration or login. 

Make sure the endpoints (`/api/register` and `/api/login`) and the `AuthModel` in your Flutter app are properly configured to handle these requests.


give the full signup page code


**Topic:** [[chatgpt-clusters/coding_web_dev]]
