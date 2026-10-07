# Comparaison Skia 2 / Skia 3 WebGPU

La nouvelle version réduit nettement la mémoire résidente après fermeture de la lecture 4K, mais consomme davantage pendant les exports répétés. La cadence reste proche de 60 callbacks/s. **Ces essais ne permettent pas de conclure à un gain global de vitesse d'export** : la direction s'inverse entre les deux paires.

Les constats répétés dans les deux ordres sont : RSS final après lecture 4K inférieur de **53 à 61 %** ; pic RSS des exports alternés supérieur de **21 à 23 %** et RSS final supérieur de **47 à 52 %**. Le RSS final est mesuré après deux secondes de stabilisation, sans forcer le GC ni purger les caches. Les résultats concernent le simulateur et ces vidéos de test, pas la consommation d'un iPhone physique ni les widgets réels de une application de montage.

**30 exécutions terminées par bibliothèque, 126 exports sondés par bibliothèque.** Cela ne vaut pas qualification complète : les comparaisons de pixels restent absentes et les seuils mémoire ne sont pas respectés. Les métadonnées natives des fichiers — dimensions, codec, nombre d'images, durée et horodatages — sont sondées ; les validateurs sémantiques supplémentaires déclarés par les scénarios restent signalés indisponibles ci-dessous.

La référence est le fork historique **0.10.1, commit `334348ffeee8a4f6887fd1f663f8cf584f579911`**, conservé inchangé. Son premier scénario avec seek a provoqué un crash : lecture AVAssetReader et annulation/recréation du lecteur concurrentes. [Analyse](../benchmark/results/baseline-crash-analysis.local.json), [rapport natif](../benchmark/results/baseline-crash-first.local.ips). Les trois nouveaux cas de lecture continue sans seek servent uniquement à isoler les mesures comparables ; ils n'effacent pas cet échec. Le correctif de synchronisation est déjà présent dans le candidat, dont les scénarios seek ciblés avaient passé avant cette comparaison.

En l'état, la migration reste intéressante pour les nouvelles fonctions et les corrections de stabilité, mais **la mémoire des exports répétés doit être traitée avant de présenter cette alpha comme une amélioration générale**. Le [guide de migration](MIGRATION.md) décrit la compatibilité et les limites actuelles.

Comparaison mesurée : **failed** selon le comparateur strict. Cette qualification conserve les échecs, les régressions et les validations média manquantes.

Ancien : @azzapp/react-native-skia-video 0.10.1, Skia 2.10.1. Nouveau : react-native-skia-webgpu-video 0.1.0-alpha.0, Skia 3.0.3.

Environnement : simulator, iPhone19,2, ios 27.0, React Native 0.86.2, release, horloge performance.now.

Ordre : ancien (AB) → nouveau (AB) → nouveau (BA) → ancien (BA). Ordre A/B puis B/A vérifié, sans chevauchement.

**Intervalle prolongé : 180.5 minutes entre candidate/AB et candidate/BA.** Les conditions du système hôte pendant cet intervalle ne sont pas contrôlées. Examiner la cohérence des résultats par paire avant de tirer une conclusion des médianes regroupées ; l'ordre A/B puis B/A ne supprime pas cette limite.

Le [test prolongé distinct de 300 exports par bibliothèque](PERFORMANCE_AB_SOAK_SIMULATOR.md) confirme le problème mémoire : après 100/200/300 exports, l’ancien reste à environ 308/315/300 Mio, le nouveau atteint 416/553/626 Mio. Après trois minutes de repos, les processus sont à **133,20 Mio et 437,38 Mio**. Les 600 fichiers ont été sondés ; l’absence de fuite n’est pas démontrée.

## Résultats regroupés

Médianes des répétitions réussies ; les effectifs restent visibles. Les six répétitions éventuelles sont regroupées depuis deux processus par version et ne constituent pas six démarrages indépendants. Pour les tailles alternées, chaque répétition pèse autant après calcul de sa propre médiane.

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 6/6 · 6/6 | 334.28 / 349.84 | +4.7 % | 307.30 / 243.46 |
| Lecture continue H.264 4K | 6/6 · 6/6 | 695.98 / 609.65 | -12.4 % | 546.51 / 245.76 |
| Lecture continue HEVC 4K | 6/6 · 6/6 | 741.91 / 722.45 | -2.6 % | 563.27 / 241.30 |
| Export H.264 | 6/6 · 6/6 | 331.44 / 345.95 | +4.4 % | 271.77 / 299.16 |
| Exports de tailles alternées | 6/6 · 6/6 | 609.32 / 719.59 | +18.1 % | 312.54 / 476.85 |

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.94 / 59.89 | ≤ 0.50 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.83 / 59.85 | ≤ 0.25 / ≤ 0.25 | ≤ 25.00 / ≤ 29.17 |
| Lecture continue HEVC 4K | 59.67 / 59.60 | ≤ 0.50 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 462.71 / 323.31 | -30.1 % | 516.88 / 347.15 |
| Exports de tailles alternées 640×360 | 18 | 90.36 / 99.80 | +10.5 % | 101.93 / 110.86 |
| Exports de tailles alternées 1920×1080 | 18 | 253.87 / 242.83 | -4.4 % | 288.27 / 273.13 |
| Exports de tailles alternées 720×1280 | 18 | 138.57 / 143.57 | +3.6 % | 156.21 / 161.78 |

Le pipeline couvre décodage, dessin et encodage, avant lecture des métadonnées. Le total inclut aussi la vérification et la suppression du fichier. La lecture mesure des callbacks, pas les images effectivement affichées ni le temps GPU ; les valeurs p95 sont les médianes des bornes supérieures du p95 par répétition. Une valeur intermédiaire comme 29,17 ms n'est donc ni une classe réelle de l'histogramme ni un p95 global recalculé.

Les scénarios steady-playback mesurent une lecture continue sans seek ; ils ne remplacent pas les scénarios historiques de seek, boucle et maintien d’image. Un échec historique de seek reste un échec fonctionnel distinct.

Les pics RSS sont échantillonnés, donc des bornes inférieures du vrai maximum. Le RSS final suit la pause de stabilisation prévue par le scénario ; les caches peuvent survivre et le processus poursuit les scénarios suivants. Ces chiffres ne démontrent ni fuite ni absence de fuite.

## Qualification et limites

Budget demandé : 512 MiB. Application ancien : non disponible ; nouveau : oui.

Les compteurs de ressources propres à la nouvelle bibliothèque restent indisponibles sur l’ancienne. Ils ne sont jamais remplacés par zéro et ne servent pas à comparer la mémoire totale. Mémoire GPU totale et tas natif séparé : non mesurés lorsque les collecteurs sont absents.

### AB — failed

- Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded
- Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only
- Export H.264 : failed. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; rssBytes peak regression ; Pixel / audio / timestamp validation incomplete
- Exports de tailles alternées : failed. rssBytes peak regression ; rssBytes grows after warmup; inspect retained resources

### BA — failed

- Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded
- Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only
- Export H.264 : incomplete. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; Pixel / audio / timestamp validation incomplete
- Exports de tailles alternées : failed. rssBytes peak regression ; rssBytes grows after warmup; inspect retained resources

## Paire AB

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 3/3 · 3/3 | 345.31 / 360.75 | +4.5 % | 319.58 / 255.66 |
| Lecture continue H.264 4K | 3/3 · 3/3 | 669.44 / 619.27 | -7.5 % | 560.91 / 261.20 |
| Lecture continue HEVC 4K | 3/3 · 3/3 | 707.58 / 746.44 | +5.5 % | 571.19 / 266.05 |
| Export H.264 | 3/3 · 3/3 | 335.56 / 383.56 | +14.3 % | 288.97 / 333.30 |
| Exports de tailles alternées | 3/3 · 3/3 | 626.33 / 769.94 | +22.9 % | 340.56 / 516.20 |

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.94 / 59.88 | ≤ 0.50 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.95 / 59.86 | ≤ 0.25 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue HEVC 4K | 59.68 / 59.53 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 210.34 / 243.86 | +15.9 % | 231.14 / 264.33 |
| Exports de tailles alternées 640×360 | 18 | 79.03 / 90.02 | +13.9 % | 89.86 / 100.75 |
| Exports de tailles alternées 1920×1080 | 18 | 209.88 / 218.75 | +4.2 % | 238.27 / 248.01 |
| Exports de tailles alternées 720×1280 | 18 | 121.07 / 132.06 | +9.1 % | 137.90 / 149.42 |

## Paire BA

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 3/3 · 3/3 | 330.47 / 346.61 | +4.9 % | 297.14 / 238.95 |
| Lecture continue H.264 4K | 3/3 · 3/3 | 722.53 / 597.34 | -17.3 % | 538.52 / 226.36 |
| Lecture continue HEVC 4K | 3/3 · 3/3 | 771.31 / 698.27 | -9.5 % | 550.84 / 216.98 |
| Export H.264 | 3/3 · 3/3 | 327.31 / 338.92 | +3.5 % | 255.92 / 291.22 |
| Exports de tailles alternées | 3/3 · 3/3 | 589.41 / 715.64 | +21.4 % | 285.06 / 418.66 |

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.94 / 59.91 | ≤ 0.50 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.70 / 59.85 | ≤ 0.25 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| Lecture continue HEVC 4K | 59.65 / 59.84 | ≤ 0.50 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 645.40 / 342.21 | -47.0 % | 676.28 / 367.64 |
| Exports de tailles alternées 640×360 | 18 | 148.12 / 109.58 | -26.0 % | 164.65 / 122.39 |
| Exports de tailles alternées 1920×1080 | 18 | 354.82 / 262.48 | -26.0 % | 387.21 / 295.18 |
| Exports de tailles alternées 720×1280 | 18 | 277.19 / 158.11 | -43.0 % | 297.92 / 176.32 |

## Traçabilité

| Version / paire | Début UTC | Fin UTC | JSON SHA-256 |
|---|---|---|---|
| baseline / AB | 2026-10-06T17:15:50.672Z | 2026-10-06T17:17:48.817Z | 577dec3b0de510c329bde0ead6120c52be98713ff0912d3689215a7c899d641d |
| candidate / AB | 2026-10-06T17:18:37.600Z | 2026-10-06T17:20:36.017Z | bcd7a67e7e0e8d26ff44573cde1d7f7c8254ae8636974cd7b535f5644506f893 |
| candidate / BA | 2026-10-06T20:21:06.503Z | 2026-10-06T20:23:08.558Z | b947db3c8910abed4ea0f89e16164d9597a3fd94fe92121b376aff631ec6e167 |
| baseline / BA | 2026-10-06T20:24:18.113Z | 2026-10-06T20:26:26.476Z | d15ab1f1c5cce937515dcad8af8a1438aacc69619d4df14782c042d1acbf86d2 |

Les fenêtres sont celles enregistrées par chaque application. Les fichiers JSON conservent les échantillons, les conditions thermiques, les résultats des vérifications et les mesures par répétition.

Provenance complémentaire : benchmark/results/ab-provenance.local.json.

Hôte : {"recordedAt":"2026-10-06T16:17:55.791Z","model":"MacBookPro18,3","cpu":"Apple M1 Pro","memoryBytes":17179869184,"macOS":"27.0.1","macOSBuild":"26A434","source":"sysctl hw.model/hw.memsize/machdep.cpu.brand_string and sw_vers"}.
