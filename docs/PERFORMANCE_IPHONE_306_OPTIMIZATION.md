# iPhone : Skia 3.0.6 initial / optimisé

Le transport optimisé réduit l’empreinte physique observée, mais **aucun gain de vitesse n’est mesuré** dans cette passe. Les quatre passages ABBA ont réussi **96/96 exécutions**, avec **24 exports / 1440 frames sondés**. Tous les **3260 relevés** sont **fair / alimentation normale / application active** : le protocole thermique **nominal n’est pas satisfait**. La qualification stricte est **incomplete**, également à cause des validateurs médias non branchés.

La [preuve publique déidentifiée](../benchmark/ios-device-306-optimization-verification.json) conserve les métriques, les deux paires, les hashes complets et leurs sources locales ignorées par Git. Les preuves [natives initiales](../benchmark/ios-native-device-306-verification.json) et [fonctionnelles du simulateur](../benchmark/ios-simulator-306-functional-verification.json) restent distinctes.

Contexte communiqué par l’utilisateur après les mesures : l’iPhone était posé sur un mini-routeur de voyage et utilisé en partage de connexion (tethering). Ce contexte externe n’a pas été instrumenté ; sa contribution thermique et sa charge en arrière-plan ne sont pas quantifiées. La chauffe ne peut donc pas être attribuée à la bibliothèque, et ces données ne permettent pas d’isoler la cause des écarts de durée. Les résultats bruts et le verdict thermique restent inchangés. Une comparaison en conditions contrôlées demanderait un téléphone refroidi, éloigné du routeur et sans partage de connexion actif.

## Ce qui est comparé

Même bibliothèque alpha, **Skia 3.0.6 / WebGPU 0.12.1**, iPhone 15 Pro / iOS 27.0.1, RN 0.86.2, Release, horloge performance.now. Huit scénarios sélectionnés, trois répétitions par processus et deux processus par variante, ordre **initial → optimisé → optimisé → initial**. Les fenêtres ne se chevauchent pas. La preview mesure **720×720 pixels physiques**, les fixtures embarquées sont vérifiées par hashes et le budget appliqué est identique : **512 Mio de réservations vidéo**. Ce résultat ne qualifie pas le catalogue complet de 65 cas.

Le build initial utilise un blit natif puis une surface GPU intermédiaire avant la copie possédée. Le build optimisé retire cette surface intermédiaire et prend son snapshot possédé depuis la texture de transfert. Les copies et l’attente nécessaires à l’indépendance des images restent présentes. Les deux chemins d’export conservent le **readback CPU et le pool de CVPixelBuffer borné** ; `gpuDirectExport` vaut `false`, y compris pour le mode direct demandé. Cette passe ne compare ni Skia 2, ni Skia 3.0.3, ni le backend Android.

## Mémoire du processus

Médianes de six répétitions réussies par variante, regroupées depuis deux processus. « Pic » désigne le maximum échantillonné dans chaque répétition ; il peut manquer une pointe. RSS et phys_footprint mesurent le processus et leurs imputations diffèrent. Les cas précédents peuvent laisser des caches ; les écarts ne sont pas une attribution exhaustive à la seule frame.

| Scénario | Pic empreinte initial / optimisé (Mio) | Écart | Empreinte settled initial / optimisé (Mio) | Pic RSS initial / optimisé (Mio) |
|---|---:|---:|---:|---:|
| H.264 1080p — copy | 184,58 / 175,27 | -5,0 % | 70,45 / 62,59 | 82,35 / 82,09 |
| H.264 4K — copy | 402,54 / 358,53 | -10,9 % | 173,50 / 131,35 | 84,28 / 84,03 |
| HEVC 4K — copy | 404,98 / 361,03 | -10,9 % | 176,90 / 135,44 | 86,42 / 86,23 |
| H.264 1080p — direct demandé | 297,56 / 255,58 | -14,1 % | 179,70 / 139,29 | 90,14 / 90,28 |
| H.264 4K — direct demandé | 411,03 / 368,40 | -10,4 % | 181,75 / 140,65 | 92,43 / 92,46 |
| HEVC 4K — direct demandé | 412,24 / 368,91 | -10,5 % | 182,77 / 144,59 | 93,75 / 93,23 |
| Export H.264 — copy | 281,24 / 239,76 | -14,8 % | 236,13 / 189,45 | 122,77 / 122,87 |
| Export H.264 — direct demandé | 316,31 / 273,38 | -13,6 % | 270,19 / 228,35 | 157,37 / 157,02 |

En lecture 4K, l’empreinte physique au pic baisse d’environ **10 à 11 %**, avec RSS pratiquement inchangé. Les **120 points settled** ont les quatre compteurs suivis à zéro : ownedBytes, ownedResources, decoderCount et inFlightFrames. Ces réservations ne mesurent pas la mémoire totale. La stabilisation programmée ne prouve ni fermeture de tous les caches/pilotes, ni palier durable, ni absence de fuite. Aucun diagnostic prolongé 3.0.6 ou repos natif n’a été ajouté à cette passe.

## Lecture et export

Les six lectures restent autour de **60 callbacks/s**, sans frame déclarée manquante. La médiane de la borne supérieure du p95 de durée murale du callback vaut **≤ 0,25 ms** des deux côtés. Les buckets ne permettent pas de mesurer un gain sous cette borne. Ces chiffres ne sont ni les FPS vidéo décodées/présentées, ni le temps GPU, ni une consommation CPU.

Les exports demandent H.264 **640×360, 30 images/s, 2 s, 60 frames**, en copy ou direct demandé. Les 24 fichiers complets ont ces dimensions, codec, durée et cadence ; les PTS sont monotones et exacts, de 0 à 59/30 s. Les pixels, la couleur, l’orientation visuelle, l’audio et l’immutabilité GPU des images détenues ne sont pas validés par cette sonde.

| Export | Pipeline initial / optimisé (ms) | Écart pipeline | Sonde initial / optimisé (ms) | Total initial / optimisé (ms) |
|---|---:|---:|---:|---:|
| Export H.264 — copy | 248,18 / 263,09 | +6,0 % | 41,07 / 41,78 | 294,91 / 307,16 |
| Export H.264 — direct demandé | 251,80 / 260,67 | +3,5 % | 41,45 / 40,90 | 295,49 / 305,08 |

Le pipeline couvre préparation, décodage, dessin, readback et encodage ; il exclut la sonde. Le total inclut aussi la sonde et la suppression du fichier. Le pipeline est environ **6,0 % plus lent en copy** et **3,5 % plus lent avec direct demandé** dans les médianes regroupées. Aucune amélioration globale de vitesse n’est établie.

## Direction dans chaque paire

Les deux ordres montrent la même direction pour l’empreinte physique et les deux pipelines d’export. Ils restent tous deux entièrement fair ; aucune paire nominale ne permet de lever cette limite.

| Scénario | Écart pic empreinte AB / BA | Écart pipeline AB / BA |
|---|---:|---:|
| H.264 1080p — copy | -5,0 % / -5,1 % | — / — |
| H.264 4K — copy | -11,0 % / -10,8 % | — / — |
| HEVC 4K — copy | -11,0 % / -10,3 % | — / — |
| H.264 1080p — direct demandé | -14,8 % / -14,0 % | — / — |
| H.264 4K — direct demandé | -10,8 % / -10,1 % | — / — |
| HEVC 4K — direct demandé | -10,8 % / -10,2 % | — / — |
| Export H.264 — copy | -15,4 % / -14,1 % | +6,2 % / +6,8 % |
| Export H.264 — direct demandé | -13,7 % / -13,5 % | +2,1 % / +5,0 % |

Les validateurs de catalogue demandés pour les exports restent indisponibles, même si leurs métadonnées sont vérifiées séparément par AVFoundation. Aucun seuil ni exigence nominale n’a été modifié pour obtenir un verdict passé. Les petits écarts temporels sont descriptifs de ce téléphone dans ces conditions ; aucun test de significativité ou intervalle de confiance n’est revendiqué.

## Traçabilité

| Passage | Variante | Début UTC | Fin UTC | Relevés fair | JSON SHA-256 |
|---|---|---|---|---:|---|
| A1 | initial | 2026-10-07T09:11:23.286Z | 2026-10-07T09:13:35.359Z | 813 | 6126537ad84f5f368a75b701e98b6a858ac5e6c3182eee0c4cd8504b0b93e173 |
| B1 | optimisé | 2026-10-07T09:14:05.347Z | 2026-10-07T09:16:17.610Z | 815 | 3bee240d07448de9114a57b8875d54bebad29af05850ad2c95a115649567f1e1 |
| B2 | optimisé | 2026-10-07T09:16:41.803Z | 2026-10-07T09:18:54.200Z | 816 | e4bd2052a8f2535fafa19a0fc34666a224c57b7c740d6596e755c71066da1814 |
| A2 | initial | 2026-10-07T09:19:23.995Z | 2026-10-07T09:21:36.326Z | 816 | 6ac7859ac63b86c8239573d83bb0c4bf8e9a049ecd230b0f308401520486cbde |

| Build gelé | Exécutable SHA-256 | Bundle Hermes SHA-256 |
|---|---|---|
| initial | d8add0b84daf5ad62f789c1cb256e02582ca62dae55287d5523664e3c250dbff | 81d05e2c71785474ac7f17bdf32c6880db7cd541ea611d4c3b979e68243f8b02 |
| optimisé | 7464c2f2c8a89a7cd42676b650b1db4f04af65fe1a5db58146fff3f13307e690 | f054c61a32aa80a64fb685c187ff2e8865206e23c3e117f9d41b6995c8fea137 |

Avant cette comparaison, le smoke physique optimisé a passé **5/5 cas**, de **09:10:13.538 à 09:11:01.576 UTC**, avec 368 relevés fair/normal/active. Ses sorties et timings restent séparés des 96 exécutions ABBA. Le build optimisé a été laissé installé après les mesures, sans lancement ni mesure supplémentaire. Les tests Android sont compilés et les suites JVM ont passé ; aucune exécution physique Android ni mesure de performance/mémoire Android n’est ajoutée par ce rapport. Les résultats [physiques Skia 3.0.3](PERFORMANCE_AB_IPHONE_303.md) et [diagnostic prolongé 3.0.3](PERFORMANCE_SOAK_IPHONE_303.md) restent historiques et séparés.
