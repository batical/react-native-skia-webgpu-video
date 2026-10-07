# Comparaison Skia 2 / Skia 3 WebGPU

**Sur cet iPhone, le candidat Skia 3.0.3 réduit l’empreinte physique pendant la lecture 4K, mais augmente la mémoire des exports. Aucun gain global de vitesse ou d’absence de fuite n’est établi.** Ces mesures concernent exclusivement **Skia 3.0.3 / WebGPU 0.11.0**, pas les versions 3.0.5 ou 3.0.6.

Les quatre passages couvrent huit scénarios, trois répétitions chacun, dans des processus neufs : **48/48 statuts `passed` pour le candidat, 47/48 pour la référence**. Au premier passage de la référence, 733 des 811 échantillons thermiques sont `fair` ; une répétition HEVC 4K échoue au contrôle de lecture. Ce constat ne prouve pas que la température a causé cet échec. Les trois autres passages sont entièrement `nominal`, avec 24/24 scénarios chacun ; tous les échantillons des quatre passages sont au premier plan et en mode d’alimentation normal. **La paire BA est donc la référence d’interprétation ci-dessous** ; les chiffres AB et regroupés restent visibles avec leur réserve thermique.

- **Lecture H.264 4K :** dans BA, le pic d’empreinte physique passe de **511,28 à 361,88 Mio en copy (−29,2 %)** et de **709,00 à 371,61 Mio avec l’option direct (−47,6 %)**. Le RSS augmente pourtant de 23,8 % et 38,2 % : ces deux collecteurs mesurent des grandeurs différentes et doivent rester présentés ensemble.
- **Exports H.264 de 60 images en 640×360 :** dans BA, l’empreinte physique au pic augmente de **33,6 % en copy** et **47,8 % avec l’option direct**. Le pipeline prend 267,24 → 245,19 ms en copy et 222,60 → 242,48 ms en direct. Ces trois répétitions de petits exports ne suffisent pas à promettre une accélération générale.
- **Lecture :** les callbacks restent proches de **60/s**, malgré une capacité d’écran déclarée à 120 Hz. La borne du p95 de leur intervalle passe de 25 à 33,33 ms en 4K ; le callback de dessin est plus court, mais sa durée exclut une partie du pipeline et ne mesure pas le temps GPU ni les images effectivement affichées.

Les demandes `copy` et `direct` gardent la même interface publique. Le candidat utilise cependant une copie GPU à l’entrée et une lecture CPU des pixels composés à l’export (`gpuDirectExport: false`), tandis que la référence possède un chemin Metal direct. Les scénarios copy précèdent systématiquement les scénarios direct dans chaque processus : les caches déjà chargés empêchent d’attribuer leurs écarts au seul mode. Les variations A/B d’un même scénario sont interprétables avec ces routes documentées ; une comparaison causale copy/direct demanderait des processus séparés et un ordre inversé.

Les **24 sorties exportées du groupe comparable** — 12 par bibliothèque — ont toutes passé les contrôles du fichier : H.264, dimensions, 60 images, 30 fps, durée de deux secondes dans la tolérance prévue et horodatages monotones/exacts. Cela ne remplace pas la validation des pixels : les validateurs de scénario déclarés indisponibles restent tels quels. Le verdict strict **`failed` est conservé**, notamment pour les régressions mémoire, l’échec de lecture et les validations manquantes. Les compteurs internes du candidat reviennent à zéro aux 48 fins de scénario ; cela ne mesure ni les caches du pilote ni la mémoire totale et ne démontre pas l’absence de fuite.

Les exports mixtes sont étudiés séparément : le premier passage complet de neuf scénarios a produit un **SIGTRAP natif dans la référence**, dans `GrResourceCache::notifyARefCntReachedZero` pendant `readPixels` sur le thread d’export. Le candidat a terminé ce passage séparé à **27/27**, dont 60 exports mixtes ; ces résultats ne sont pas incorporés aux médianes des huit scénarios ci-dessous. Le test d’endurance de 300 exports de la référence a ensuite subi un second SIGTRAP, dans `GrResourceCache::removeResource` lors de la destruction d’une surface par le thread GC `hades`. Les deux piles concernent les ressources Ganesh, mais leur mécanisme causal précis reste inconnu. Les fichiers restants suggèrent respectivement le 17e export de la deuxième répétition et le 68e export de l’endurance ; aucun résultat partiel n’est inventé. [Premier rapport de crash](../benchmark/results/iphone-a1-baseline-303-crash-analysis.local.json), [rapport du test d’endurance](../benchmark/results/iphone-soak-baseline-303-crash-analysis.local.json). Le candidat a ensuite terminé les **300 exports** ; sa mémoire augmente entre les trois lots, et le collecteur de repos a expiré sans produire de relevé. Le [rapport d’endurance](PERFORMANCE_SOAK_IPHONE_303.md) conserve ces résultats et leurs limites ; aucun palier ni absence de fuite ne sont démontrés.

La source historique est restée propre au commit `334348ffeee8a4f6887fd1f663f8cf584f579911`. L’ordre ABBA, les identités de processus distinctes, les hachages des exécutables/bundles identiques par bibliothèque, les fixtures et les collecteurs ont été revérifiés : [preuve publique sans identifiant d’appareil](../benchmark/ab-iphone-303-verification.json). Cette référence emploie **Skia 2.10.1 / React Native 0.86.2**. Ces mesures portent sur la pile du benchmark. Les crashs et les chiffres ne se transposent pas automatiquement à une application utilisant d’autres versions ou workloads.

Comparaison mesurée : **failed** selon le comparateur strict. Cette qualification conserve les échecs, les régressions et les validations média manquantes.

Ancien : @azzapp/react-native-skia-video 0.10.1, Skia 2.10.1. Nouveau : react-native-skia-webgpu-video 0.1.0-alpha.0, Skia 3.0.3.

Environnement : device, iPhone16,1, ios 27.0.1, React Native 0.86.2, release, horloge performance.now.

Ordre : ancien (AB) → nouveau (AB) → nouveau (BA) → ancien (BA). Ordre A/B puis B/A vérifié, sans chevauchement.

## Résultats regroupés

Médianes des répétitions réussies ; les effectifs restent visibles. Les six répétitions éventuelles sont regroupées depuis deux processus par version et ne constituent pas six démarrages indépendants. Pour les tailles alternées, chaque répétition pèse autant après calcul de sa propre médiane.

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 6/6 · 6/6 | 65.12 / 80.30 | +23.3 % | 65.11 / 80.30 |
| Lecture continue H.264 4K | 6/6 · 6/6 | 66.26 / 82.84 | +25.0 % | 66.24 / 82.80 |
| Lecture continue HEVC 4K | 5/6 · 6/6 | 66.39 / 85.95 | +29.5 % | 66.36 / 85.95 |
| steady-playback-h264-1080p30-audio-direct | 6/6 · 6/6 | 66.87 / 89.66 | +34.1 % | 66.83 / 89.64 |
| steady-playback-h264-4k30-direct | 6/6 · 6/6 | 67.06 / 93.31 | +39.1 % | 67.02 / 93.30 |
| steady-playback-hevc-4k30-direct | 6/6 · 6/6 | 67.28 / 96.77 | +43.8 % | 67.24 / 96.77 |
| Export H.264 | 6/6 · 6/6 | 78.78 / 124.47 | +58.0 % | 73.59 / 123.98 |
| encode-h264-direct | 6/6 · 6/6 | 74.35 / 155.81 | +109.6 % | 74.35 / 154.86 |

| Scénario | Pic empreinte physique ancien / nouveau (MiB) | Écart empreinte | Empreinte finale ancien / nouveau (MiB) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 207.29 / 172.42 | -16.8 % | 133.40 / 67.31 |
| Lecture continue H.264 4K | 513.49 / 364.89 | -28.9 % | 387.00 / 170.53 |
| Lecture continue HEVC 4K | 479.86 / 366.87 | -23.5 % | 385.92 / 173.63 |
| steady-playback-h264-1080p30-audio-direct | 242.28 / 285.42 | +17.8 % | 201.43 / 177.01 |
| steady-playback-h264-4k30-direct | 709.10 / 374.61 | -47.2 % | 639.52 / 180.61 |
| steady-playback-hevc-4k30-direct | 694.56 / 377.87 | -45.6 % | 639.70 / 183.08 |
| Export H.264 | 206.72 / 277.79 | +34.4 % | 149.78 / 234.81 |
| encode-h264-direct | 191.63 / 309.33 | +61.4 % | 155.17 / 266.69 |

L’empreinte physique iOS provient de task_vm_info phys_footprint. Elle est mesurée séparément du RSS et reste indisponible lorsqu’aucun collecteur ne la fournit.

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.97 / 59.95 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.88 / 59.95 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| Lecture continue HEVC 4K | 59.88 / 59.87 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-h264-1080p30-audio-direct | 59.96 / 60.07 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| steady-playback-h264-4k30-direct | 59.95 / 59.91 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-hevc-4k30-direct | 59.95 / 59.95 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 257.19 / 243.41 | -5.4 % | 297.57 / 291.07 |
| encode-h264-direct 640×360 | 60 | 221.71 / 234.77 | +5.9 % | 263.26 / 283.55 |

Le pipeline couvre décodage, dessin et encodage, avant lecture des métadonnées. Le total inclut aussi la vérification et la suppression du fichier. La lecture mesure des callbacks, pas les images effectivement affichées ni le temps GPU ; les valeurs p95 sont les médianes des bornes supérieures du p95 par répétition, pas un p95 global recalculé.

Les scénarios steady-playback mesurent une lecture continue sans seek ; ils ne remplacent pas les scénarios historiques de seek, boucle et maintien d’image. Un échec historique de seek reste un échec fonctionnel distinct.

Les pics RSS sont échantillonnés, donc des bornes inférieures du vrai maximum. Le RSS final suit la pause de stabilisation prévue par le scénario ; les caches peuvent survivre et le processus poursuit les scénarios suivants. Ces chiffres ne démontrent ni fuite ni absence de fuite.

## Qualification et limites

Budget demandé : 512 MiB. Application ancien : non disponible ; nouveau : oui.

Les compteurs de ressources propres à la nouvelle bibliothèque restent indisponibles sur l’ancienne. Ils ne sont jamais remplacés par zéro et ne servent pas à comparer la mémoire totale. Mémoire GPU totale et tas natif séparé : non mesurés lorsque les collecteurs sont absents.

### AB — failed

- Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded
- Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only
- Lecture continue H.264 1080p : failed. Thermal state was non-nominal during the workload ; rssBytes peak regression
- Lecture continue H.264 4K : failed. Thermal state was non-nominal during the workload ; rssBytes peak regression
- Lecture continue HEVC 4K : failed. Baseline correctness / termination failure ; At least three successful repetitions per backend are required ; Thermal state was non-nominal during the workload ; rssBytes peak regression
- steady-playback-h264-1080p30-audio-direct : failed. Thermal state was non-nominal during the workload ; rssBytes peak regression ; physicalFootprintBytes peak regression
- steady-playback-h264-4k30-direct : failed. Thermal state was non-nominal during the workload ; rssBytes peak regression
- steady-playback-hevc-4k30-direct : failed. Thermal state was non-nominal during the workload ; rssBytes peak regression
- Export H.264 : failed. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; Thermal state was non-nominal during the workload ; rssBytes peak regression ; physicalFootprintBytes peak regression ; Pixel / audio / timestamp validation incomplete
- encode-h264-direct : failed. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; Thermal state was non-nominal during the workload ; rssBytes peak regression ; physicalFootprintBytes peak regression ; Pixel / audio / timestamp validation incomplete

### BA — failed

- Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded
- Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only
- Lecture continue H.264 1080p : failed. rssBytes peak regression
- Lecture continue H.264 4K : failed. rssBytes peak regression
- Lecture continue HEVC 4K : failed. rssBytes peak regression
- steady-playback-h264-1080p30-audio-direct : failed. rssBytes peak regression ; physicalFootprintBytes peak regression
- steady-playback-h264-4k30-direct : failed. rssBytes peak regression
- steady-playback-hevc-4k30-direct : failed. rssBytes peak regression
- Export H.264 : failed. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; rssBytes peak regression ; physicalFootprintBytes peak regression ; Pixel / audio / timestamp validation incomplete
- encode-h264-direct : failed. Baseline: Media validation unavailable: pixels ; Baseline: Media validation unavailable: presentation-timestamps ; Baseline: Media validation unavailable: actual-codec ; Candidate: Media validation unavailable: pixels ; Candidate: Media validation unavailable: presentation-timestamps ; Candidate: Media validation unavailable: actual-codec ; rssBytes peak regression ; physicalFootprintBytes peak regression ; Pixel / audio / timestamp validation incomplete

## Paire AB

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 3/3 · 3/3 | 65.14 / 81.16 | +24.6 % | 65.13 / 81.14 |
| Lecture continue H.264 4K | 3/3 · 3/3 | 66.58 / 83.73 | +25.8 % | 66.56 / 83.73 |
| Lecture continue HEVC 4K | 2/3 · 3/3 | 66.66 / 86.72 | +30.1 % | 66.63 / 86.72 |
| steady-playback-h264-1080p30-audio-direct | 3/3 · 3/3 | 67.11 / 90.34 | +34.6 % | 67.08 / 90.33 |
| steady-playback-h264-4k30-direct | 3/3 · 3/3 | 67.30 / 94.06 | +39.8 % | 67.27 / 94.06 |
| steady-playback-hevc-4k30-direct | 3/3 · 3/3 | 67.55 / 97.78 | +44.8 % | 67.52 / 97.78 |
| Export H.264 | 3/3 · 3/3 | 79.30 / 123.98 | +56.4 % | 73.97 / 123.98 |
| encode-h264-direct | 3/3 · 3/3 | 74.64 / 156.69 | +109.9 % | 74.64 / 154.86 |

| Scénario | Pic empreinte physique ancien / nouveau (MiB) | Écart empreinte | Empreinte finale ancien / nouveau (MiB) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 206.81 / 173.20 | -16.3 % | 132.38 / 68.89 |
| Lecture continue H.264 4K | 515.53 / 367.86 | -28.6 % | 385.30 / 171.64 |
| Lecture continue HEVC 4K | 495.70 / 370.30 | -25.3 % | 398.88 / 174.24 |
| steady-playback-h264-1080p30-audio-direct | 242.38 / 288.49 | +19.0 % | 201.36 / 177.72 |
| steady-playback-h264-4k30-direct | 709.24 / 377.38 | -46.8 % | 636.75 / 183.47 |
| steady-playback-hevc-4k30-direct | 709.39 / 380.78 | -46.3 % | 639.10 / 187.19 |
| Export H.264 | 175.64 / 279.20 | +59.0 % | 134.41 / 236.91 |
| encode-h264-direct | 176.02 / 312.30 | +77.4 % | 139.53 / 269.78 |

L’empreinte physique iOS provient de task_vm_info phys_footprint. Elle est mesurée séparément du RSS et reste indisponible lorsqu’aucun collecteur ne la fournit.

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.96 / 59.96 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.87 / 59.95 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| Lecture continue HEVC 4K | 59.92 / 59.87 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-h264-1080p30-audio-direct | 59.95 / 60.16 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| steady-playback-h264-4k30-direct | 59.93 / 59.86 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-hevc-4k30-direct | 59.95 / 59.97 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 247.15 / 242.08 | -2.0 % | 287.95 / 291.33 |
| encode-h264-direct 640×360 | 60 | 219.51 / 232.09 | +5.7 % | 260.41 / 279.86 |

## Paire BA

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Lecture continue H.264 1080p | 3/3 · 3/3 | 65.09 / 79.77 | +22.5 % | 65.09 / 79.75 |
| Lecture continue H.264 4K | 3/3 · 3/3 | 66.25 / 82.05 | +23.8 % | 66.23 / 82.05 |
| Lecture continue HEVC 4K | 3/3 · 3/3 | 66.33 / 85.00 | +28.2 % | 66.30 / 85.00 |
| steady-playback-h264-1080p30-audio-direct | 3/3 · 3/3 | 66.61 / 88.67 | +33.1 % | 66.58 / 88.64 |
| steady-playback-h264-4k30-direct | 3/3 · 3/3 | 66.80 / 92.33 | +38.2 % | 66.72 / 92.33 |
| steady-playback-hevc-4k30-direct | 3/3 · 3/3 | 67.00 / 96.22 | +43.6 % | 66.97 / 96.22 |
| Export H.264 | 3/3 · 3/3 | 78.70 / 124.95 | +58.8 % | 73.31 / 123.98 |
| encode-h264-direct | 3/3 · 3/3 | 74.06 / 154.94 | +109.2 % | 74.06 / 154.86 |

| Scénario | Pic empreinte physique ancien / nouveau (MiB) | Écart empreinte | Empreinte finale ancien / nouveau (MiB) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 207.77 / 171.06 | -17.7 % | 134.53 / 66.02 |
| Lecture continue H.264 4K | 511.28 / 361.88 | -29.2 % | 388.14 / 169.97 |
| Lecture continue HEVC 4K | 479.75 / 363.39 | -24.3 % | 385.92 / 172.94 |
| steady-playback-h264-1080p30-audio-direct | 242.19 / 281.70 | +16.3 % | 204.31 / 176.42 |
| steady-playback-h264-4k30-direct | 709.00 / 371.61 | -47.6 % | 639.52 / 179.55 |
| steady-playback-hevc-4k30-direct | 677.58 / 375.10 | -44.6 % | 639.74 / 179.44 |
| Export H.264 | 206.81 / 276.38 | +33.6 % | 164.94 / 232.72 |
| encode-h264-direct | 207.30 / 306.36 | +47.8 % | 170.81 / 263.60 |

L’empreinte physique iOS provient de task_vm_info phys_footprint. Elle est mesurée séparément du RSS et reste indisponible lorsqu’aucun collecteur ne la fournit.

| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |
|---|---:|---:|---:|
| Lecture continue H.264 1080p | 59.98 / 59.95 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| Lecture continue H.264 4K | 59.89 / 59.96 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| Lecture continue HEVC 4K | 59.71 / 59.86 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-h264-1080p30-audio-direct | 59.97 / 59.97 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 25.00 |
| steady-playback-h264-4k30-direct | 59.95 / 59.96 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |
| steady-playback-hevc-4k30-direct | 59.95 / 59.87 | ≤ 1.00 / ≤ 0.25 | ≤ 25.00 / ≤ 33.33 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Export H.264 640×360 | 60 | 267.24 / 245.19 | -8.3 % | 307.18 / 290.81 |
| encode-h264-direct 640×360 | 60 | 222.60 / 242.48 | +8.9 % | 263.31 / 296.83 |

## Traçabilité

| Version / paire | Début UTC | Fin UTC | JSON SHA-256 |
|---|---|---|---|
| baseline / AB | 2026-10-07T07:44:15.822Z | 2026-10-07T07:46:27.608Z | 003d3f35182e1e065ed82a017495a4f8f1ee502cbfac71d812892e3ead83194e |
| candidate / AB | 2026-10-07T07:51:39.291Z | 2026-10-07T07:53:51.311Z | 7238e44ccf7bf1806df6f9de032d312a53dd75f959e3d29f4f214d4aecce0ba1 |
| candidate / BA | 2026-10-07T07:54:39.689Z | 2026-10-07T07:56:51.876Z | 810c896c05ac7ebe0bcec50887b54155ab5a9e0bf6ba0035dffe3660725b37fa |
| baseline / BA | 2026-10-07T07:57:33.980Z | 2026-10-07T07:59:45.784Z | 31f5251e0b2b396cc507253cc93398379cc6b06010c4bb2ac6a75f26ac91b1d1 |

Les fenêtres sont celles enregistrées par chaque application. Les fichiers JSON conservent les échantillons, les conditions thermiques, les résultats des vérifications et les mesures par répétition.
