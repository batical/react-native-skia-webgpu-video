# Exécuter les tests sur l'iPhone

L'application de test est isolée dans [`example`](../example). Le workspace est `example/ios/ReactNativeSkiaWebGPUVideoExample.xcworkspace`, le schéma **ReactNativeSkiaWebGPUVideoExample** et la destination est votre iPhone connecté. Les bundle IDs `com.seb.skiawebgpuvideo.test` et `com.seb.skiawebgpuvideo.test.tests` permettent d'installer l'exemple séparément de l'application existante.

Le premier build **Skia 3.0.6 / WebGPU 0.12.1** a passé **50/50 XCTest natifs**, aucun échec ni skip, sur **iPhone 15 Pro / iOS 27.0.1**, terminé le **7 octobre à 08:23:15.311 UTC** : [preuve native 3.0.6](../benchmark/ios-native-device-306-verification.json). Ce run valide les cas natifs du build initial. Après les refus initiaux de lancement sur iPhone verrouillé, le smoke optimisé a passé **5/5 cas physiques**. La [comparaison initial/optimisé 3.0.6](PERFORMANCE_IPHONE_306_OPTIMIZATION.md) a terminé **96/96 exécutions et 24 fichiers / 1440 frames sondés** ; tous les relevés sont fair/normal/active, donc le protocole nominal n’est pas satisfait. La baisse descriptive d’empreinte physique ne s’accompagne pas d’un gain global de vitesse. Le build optimisé est laissé installé après cette passe. Le transport optimisé a passé **14/14 cas ciblés sur simulateur Release**, une répétition chacun, avec **27 exports / 1320 frames sondés** et compteurs suivis à zéro après fermeture : [preuve fonctionnelle distincte](../benchmark/ios-simulator-306-functional-verification.json). Les pixels réels et l’immutabilité visuelle held restent non validés ; ce run ne remplace pas les essais physiques ou une comparaison de performance. Sur l’hôte, le premier run a passé 154 tests Jest / 8 suites ; le transport optimisé a ensuite passé **157 Jest**, les **4 tests du patch**, Bob et publint strict. La [preuve hôte actuelle](../benchmark/host-verification.json), renouvelée à **08:57:51 UTC**, conserve **189 assertions suivies** après les dernières modifications (157 Jest, 20 C++ historiques, 12 JVM historiques).

Les essais physiques **Skia 3.0.3** ont **repris le 7 octobre 2026**. La suite native Release a passé **50/50 XCTest, aucun échec ni skip**, sur **iPhone 15 Pro / iOS 27.0.1**, terminée à **07:23:57 UTC**. [ios-native-device-verification.json](../benchmark/ios-native-device-verification.json) conserve les 50 noms passés, le SDK `iphoneos27.0` et les empreintes des sources vérifiées. Cette preuve native ne constitue pas une mesure de performance ni un A/B.

Le smoke du candidat a réussi **5/5 scénarios sur une répétition** ; deux scénarios `direct` de la référence ont également réussi. Ces premiers runs sont fonctionnels : les relevés d'un cas avant activation de l'application restent exclus du timing A/B. Après ajout de la garde commune de premier plan, le [comparatif physique court 3.0.3](PERFORMANCE_AB_IPHONE_303.md) couvre huit scénarios en ABBA : **48/48 réussites candidat, 47/48 référence**. Le premier passage de la référence est principalement fair et conserve un échec HEVC ; la paire BA est entièrement nominale. Ces résultats ciblés ne qualifient pas les 65 workloads du catalogue.

Le [diagnostic physique de 300 exports](PERFORMANCE_SOAK_IPHONE_303.md) a passé **3/3 blocs et sondé les 300 fichiers**, avec croissance de la mémoire du processus. Le collecteur de repos a ensuite dépassé son délai à **08:11:30 UTC**, sans fichier de relevés, puis le runner a arrêté son application. Le statut global de l'expérience conserve cet échec de collecte, distinct des exports réussis. La référence a subi un SIGTRAP natif sans JSON comparable. Les tests 3.0.3 sont désormais arrêtés à la demande utilisateur ; la migration **Skia 3.0.6 / WebGPU 0.12.1** a passé sa première suite native iPhone, décrite séparément ci-dessus, avec validation fonctionnelle ciblée du transport optimisé sur simulateur, avec comparaison physique initial/optimisé désormais mesurée séparément ; les performances nominales et un palier physique durable restent à qualifier.

Les applications mesurées utilisent RN 0.86.2 et React 19.2.3. Le candidat de ces rapports utilise Skia 3.0.3 / Dawn / WebGPU 0.11.0, Reanimated 4.5.3 et Worklets 0.11.3. Le manifeste courant a désormais migré vers Skia 3.0.6 / WebGPU 0.12.1. Son premier build a passé 50 XCTest ; une nouvelle compilation ne reproduit pas les binaires 3.0.3 archivés et doit qualifier les optimisations intervenues depuis. Les versions de Skia et des runtimes propres à la référence doivent rester consignées ; elles font partie de la différence étudiée. La [compilation initiale sans signature](../benchmark/ios-build-verification.json) et les [résultats simulateur](IOS_SIMULATOR_TESTS.md) restent des preuves distinctes.

## Signature et choix de la cible

1. Ouvrir le fichier `.xcworkspace` indiqué ci-dessus dans Xcode.
2. Dans **Xcode > Settings > Accounts**, connecter le compte Apple de développement si aucun compte n'est présent. Effectuer cette connexion directement dans Xcode ; aucun mot de passe ne doit être partagé dans le chat ou enregistré dans le dépôt.
3. Dans **Signing & Capabilities**, choisir l'équipe de développement et activer **Automatically manage signing** pour l'application **et** `ReactNativeSkiaWebGPUVideoExampleTests`. Conserver leurs bundle IDs distincts. Un certificat présent sur le Mac ne suffit pas si le profil de ces cibles manque.
4. Sélectionner le schéma **ReactNativeSkiaWebGPUVideoExample** et la destination correspondant à votre iPhone. Garder le téléphone connecté et déverrouillé pendant l'installation.

Le projet public ne contient aucune équipe de signature. Utiliser `--team APPLE_TEAM_ID` pour signer sans enregistrer cet identifiant dans le projet ; si vous configurez l’équipe directement dans Xcode, conserver cette modification localement. Si l'appareil refuse un certificat, l'approuver dans **Settings > General > VPN & Device Management**. La déclaration UIScene et le linkage XCTest ont été corrigés après l'échec initial de lancement.

Le script depuis la racine du dépôt reprend la compilation et l'exécution en Release :

```sh
node scripts/test-ios-device.mjs --device IPHONE_UDID --team APPLE_TEAM_ID --native
node scripts/test-ios-device.mjs --device IPHONE_UDID --team APPLE_TEAM_ID --launch --profile smoke
```

Remplacer `IPHONE_UDID` par l'identifiant dans Xcode. Le script utilise aussi `example/device.local.json` lorsqu'il existe. L'option `--team APPLE_TEAM_ID` permet de choisir explicitement une équipe ; en son absence, il conserve la configuration Xcode. `--launch` seul ouvre le menu, `--profile full` et `--profile soak` démarrent les autres profils. `--build-only` compile et signe sans exécuter ; `--unsigned` ne vérifie que la compilation et ne peut pas installer l'application. Le dossier des logs et du `.xcresult` est affiché par le script.

## Les 50 cas natifs

Le schéma partagé utilise désormais **Release** pour l'action Test. Lancer **Product > Test** ou **Cmd+U**. Si le schéma a été modifié localement, vérifier sa configuration dans **Product > Scheme > Edit Scheme**.

La cible utilise [`ios/tests/LegacyParityTests.mm`](../ios/tests/LegacyParityTests.mm) : décodeurs, fenêtre de frames, preview, export, orientation, timestamps, fermeture et slow motion. Le test slow motion construit sa propre présentation par edit list ; la fixture commune au benchmark a également été produite comme fichier autonome. Conserver le rapport `.xcresult` et les échecs éventuels. Une compilation des 50 méthodes ne doit jamais être enregistrée comme 50 tests réussis.

Les deux runs natifs physiques 3.0.3 puis 3.0.6 ont été vérifiés contre **les 50 méthodes concrètes des sources**. La preuve initiale 3.0.6 contrôle 54 entrées iOS/C++/pods/manifeste/headers patchés et leurs dates avant l’invocation ; elle exclut les sources Android/JavaScript et ne fabrique pas de fingerprint global pré-build. L’empreinte limitée `e8fafd5b…` et les hashes du binaire/bundle XCTest archivé permettent de distinguer ce premier build des optimisations ultérieures. Le run **3.0.3** avait été vérifié avec une seule destination iOS physique et un statut Passed pour chaque nom. Les 100 fichiers de production, dépendances, projet et fixture contrôlés précèdent le début de la compilation et sont restés inchangés pendant l'extraction. L'empreinte de production est `486b12a…`. Le test JPEG impair utilise la vraie fixture 1279×719. La modification ultérieure de la garde de premier plan du harness concerne les mesures JavaScript ; elle ne transforme pas cette suite native en qualification du harness.

La tentative du **6 octobre**, avant correctifs, reste conservée avec **45 réussites et 5 échecs**, sans skip, dans [ios-native-device-attempt.json](../benchmark/ios-native-device-attempt.json). Elle portait sur les petites seeks, le scrub, le seek en pause, les dimensions impaires et la slow motion. Le premier smoke de ce jour avait échoué au montage (`Cannot read property 'current' of undefined`) puis bloqué quatre cas, avec des ressources suivies encore présentes. Ces résultats historiques et leurs JSON bruts ne sont pas remplacés par le succès actuel.

## Lecture, export et mémoire en Release

L'action **Run** du schéma utilise aussi **Release**. Reconstruire l'application après les dernières modifications JavaScript/natives, puis lancer **Product > Run** ou **Cmd+R**. Le bundle Release est intégré à l'application ; il permet de poursuivre les tests sans dépendre d'une connexion à Metro. Le bandeau « Build Debug » doit être absent dans l'écran de test.

L'écran propose :

- **Test rapide** : vérifier d'abord la lecture, l'export et la fermeture sur le téléphone.
- **Tous les scénarios** : parcourir le catalogue actuel de **65 workloads**, version **2026-10-07.1**.
- **Test prolongé** : augmenter les seeks et les cycles de création/fermeture pour suivre la croissance mémoire après warmup.

Chaque profil utilise par défaut **trois répétitions**, le manifest des fichiers et un budget explicite de **512 Mio de réservations internes**. Une répétition sert d'abord à vérifier le fonctionnement. Cette configuration de benchmark diffère de la valeur par défaut de 256 Mio de la bibliothèque ; reprendre la même limite et les mêmes options dans le build de référence.

Quatorze médias sont présents dans `example/fixtures` et sondés par AVFoundation : H.264/HEVC, 4K, 60 fps, HLG 10 bits, rotations, audio et slow motion avec edit list. La preuve d'inclusion du simulateur ne remplace pas celle des builds physiques : le runner A/B vérifie le manifest et les hashes des médias embarqués dans chacun des `.app` signés. Les adaptateurs LUT/compute/Three.js/Core ML ne sont pas branchés dans cet écran : leurs cas restent des **non exécutés** explicites. La présence d'un média HLG ne qualifie pas sa précision colorimétrique. Les preuves de génération et d'inclusion initiale sont dans [fixture-generation-status.json](../benchmark/fixture-generation-status.json) et [fixture-bundle-verification.json](../benchmark/fixture-bundle-verification.json).

Depuis la version de workload **2026-10-06.3**, la preview demande **720×720 pixels physiques**, soit environ 240×240 points sur cet iPhone à 3x. Le JSON conserve PixelRatio, les dimensions logiques et les dimensions réellement dessinées. Chaque répétition monte puis démonte un enfant avec son Canvas et son hook ; la fermeture attend l'accusé de traitement de la queue UI. Une ancienne mesure à 720 points / 2160 pixels ne se compare pas à cette version.

Le module natif de l'exemple lit séparément le **RSS du processus** avec `mach task_info resident_size` et l'**empreinte physique** avec `task_vm_info phys_footprint`, les conditions thermiques/alimentation via `NSProcessInfo`, et décode les fichiers exportés pour contrôler leurs métadonnées, le nombre de frames et les timestamps. Le harness relève ces conditions et l'état de premier plan avec chaque point mémoire. Ces deux métriques concernent tout le processus et ne s'additionnent pas. La mémoire du heap natif et la mémoire GPU totale restent indisponibles sans collecteur supplémentaire. Une progression réussie ou un compteur interne revenu à zéro ne remplace pas ces mesures physiques.

Les trois workloads `steady-playback-*` mesurent la lecture sans seeks préalables ; chacun possède une variante `-direct` avec les mêmes temps de composition. Les anciens `single-*` gardent les seeks et tests de cycle de vie. Comparer les mêmes IDs dans les deux builds. Le mode demandé `direct` reste distinct du transport réel annoncé par le backend : le candidat conserve ses copies de référence, même lorsque ce mode est demandé.

## Récupérer les résultats et comparer

Chaque profil terminé écrit un fichier `candidate-<timestamp>.json` dans **Documents/benchmark-results**. Le chemin apparaît aussi dans la console de l'application. Le dossier sert également aux exports temporaires ; le harness les supprime après validation.

Dans **Xcode > Window > Devices and Simulators**, sélectionner votre iPhone, puis l'application installée. Utiliser **Download Container** pour conserver son conteneur. Les fichiers JSON se trouvent dans `AppData/Documents/benchmark-results` du `.xcappdata` téléchargé. Garder les résultats bruts et le rapport XCTest avant de nettoyer ou réinstaller l'application.

Pour préparer les deux builds séparés, depuis la racine :

```sh
node scripts/test-ios-device.mjs --device IPHONE_UDID --team APPLE_TEAM_ID --build-only
node scripts/test-ios-baseline-device.mjs --device IPHONE_UDID --team APPLE_TEAM_ID
```

La référence isolée est dans `example-baseline`, avec le schéma **ReactNativeSkiaVideoBaseline** et le bundle `com.seb.skiavideo.baseline.test`. Le script de référence exige que `example-baseline/device.local.json` corresponde à l'iPhone demandé ; garder cette identité et `example/device.local.json` dans les fichiers locaux ignorés. `--team APPLE_TEAM_ID` choisit l'équipe de signature. `--install` installe la référence sans lancer de mesures. Les sources du dépôt historique restent inchangées. Conserver les chemins des deux `.app` **Release-iphoneos** imprimés par les builds.

Le runner physique utilise ces produits déjà compilés. Exemple de sélection lecture/export en `direct`, à lancer avec des labels uniques :

```sh
node scripts/test-ios-device-ab-run.mjs --device IPHONE_UDID --backend baseline --label iphone-a1-baseline --app /path/Release-iphoneos/ReactNativeSkiaVideoBaseline.app --profile full --case steady-playback-h264-1080p30-audio-direct --case encode-h264-direct --repetitions 3 --idle-seconds 180 --poll-seconds 30
node scripts/test-ios-device-ab-run.mjs --device IPHONE_UDID --backend candidate --label iphone-b1-candidate --app /path/Release-iphoneos/ReactNativeSkiaWebGPUVideoExample.app --profile full --case steady-playback-h264-1080p30-audio-direct --case encode-h264-direct --repetitions 3 --idle-seconds 180 --poll-seconds 30
```

Répéter ensuite la référence avec un nouveau label `iphone-a2-baseline` pour vérifier la dérive avant/après le candidat. Remplacer les chemins et l'UDID génériques par ceux des builds signés. Répéter `--case ID` pour les autres cas 4K/HEVC ; ne pas modifier les IDs, paramètres, fixtures ou instrumentation entre les deux versions. `--profile soak --case repeated-mixed-size-exports --repetitions 3` produit un diagnostic distinct de 300 exports. Un profil long ne se fusionne pas avec les mesures de lecture.

Le runner attend jusqu’à **120 secondes** par défaut si iOS refuse explicitement le lancement avec `BSErrorCodeDescription = Locked`. `--unlock-wait-seconds 0` désactive cette attente ; une valeur jusqu’à 600 secondes est autorisée. Déverrouiller le téléphone pendant cette attente. Seul ce refus de verrouillage provoque un retry du lancement ; les erreurs réseau, de signature ou les crashs ne sont pas assimilés à un verrouillage. Cette attente avant lancement ne change ni la fenêtre mesurée ni le collecteur à 100 ms. Les dix tests ciblés du runner ont passé sur l’hôte.

`--idle-seconds` demande des relevés natifs dans l'application toutes les 30 secondes après le run, jusqu'à 600 secondes ; la valeur doit être un multiple de 30. `--poll-seconds` règle seulement la récupération des fichiers, entre 15 et 60 secondes. Un PID retourné par l'iPhone n'est jamais utilisé avec `ps` sur le Mac. Le runner installe et vérifie les hashes avant la mesure, démarre un processus neuf et ne termine que les deux applications de test identifiées. Une coupure de lecture du device conserve le run et provoque une nouvelle tentative ; l'application Release contient son bundle et ne dépend pas de Metro.

Chaque label conserve trois fichiers locaux distincts : `LABEL.local.json` (mesures originales), `LABEL-execution.local.json` (identité, hashes, commandes et interruptions), puis `LABEL-idle.local.json` si le repos a été demandé. Un label déjà présent est refusé pour préserver les résultats précédents. Le runner contrôle l'identité de l'iPhone, le processus, le run, le catalogue exact, le mode Release et le collecteur commun de 100 ms ; récupérer un JSON ne signifie pas que tous ses cas ont réussi.

Comparer ensuite les JSON correspondant aux mêmes cas :

```sh
node scripts/benchmark-compare.mjs baseline.json candidate.json comparison.json
```

Le candidat seul ne donne aucune conclusion A/B. Un skip, des métriques absentes, moins de trois répétitions, des fixtures différentes ou des conditions qui changent rendent la qualification incomplète. Les callbacks/s ne sont pas des FPS vidéo décodées, le temps mural du callback ne mesure pas le temps GPU, et le RSS représente tout le processus. [BENCHMARKS.md](BENCHMARKS.md) décrit les seuils, les collecteurs et l'interprétation  ; le [guide de migration](MIGRATION.md) décrit les limites actuelles.

Les rapports bruts du smoke restent dans `benchmark/results/iphone-smoke-candidate-20261007.local.json` et `iphone-direct-smoke-baseline-20261007.local.json`. Les extractions natives exactes sont conservées séparément dans `ios-native-device-xcresult-20261007.local.json` (3.0.3) et `ios-native-device-306-xcresult-20261007.local.json` (3.0.6). Les rapports [courts](PERFORMANCE_AB_IPHONE_303.md) et [prolongés](PERFORMANCE_SOAK_IPHONE_303.md) identifient leurs propres sources et hashes ; aucun résultat 3.0.3 n'est renommé en test 3.0.6. Ces fichiers locaux portent des identités privées et restent ignorés par Git et exclus du paquet. Le guide et les preuves publiques utilisent uniquement des champs anonymisés.
