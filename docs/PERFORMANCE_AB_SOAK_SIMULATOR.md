# Mémoire comparée — 300 exports par bibliothèque

Chaque bibliothèque a terminé trois blocs de 100 exports alternant 640×360, 1920×1080 et 720×1280. Les **600 fichiers** ont été sondés, sans erreur de dimensions, codec, nombre d’images ou horodatages. Ce diagnostic reste distinct des deux paires de cinq scénarios ; un seul ordre ancien → nouveau a été exécuté pour cette session longue.

**La mémoire du nouveau moteur continue de monter pendant les trois blocs.** Les compteurs propres au candidat reviennent à zéro, mais ils ne représentent pas les allocations opaques du processus. La baisse observée au repos ne prouve ni un palier stable ni une absence de fuite.

| Exports terminés | RSS après stabilisation ancien (Mio) | Nouveau (Mio) |
|---|---:|---:|
| 100 | 308.02 | 415.81 |
| 200 | 314.88 | 552.64 |
| 300 | 300.41 | 626.03 |
| Pic échantillonné de la session entière | 612.27 | 886.83 |

Le tableau précédent utilise le collecteur natif commun `mach task_info`. Ensuite, le même processus reste ouvert sur l’écran de résultats ; `ps` relève son RSS toutes les 30 secondes. Ces deux collecteurs sont distingués : les valeurs immédiates ne sont pas supposées interchangeables. Aucun GC forcé, purge globale, redémarrage ou profilage d’allocations n’intervient pendant le repos.

| Temps de repos après sauvegarde | RSS ancien (Mio, ps) | Nouveau (Mio, ps) |
|---|---:|---:|
| 0 s | 330.47 | 635.55 |
| 30 s | 330.63 | 570.48 |
| 60 s | 277.00 | 485.52 |
| 90 s | 198.91 | 463.31 |
| 120 s | 175.13 | 440.66 |
| 150 s | 165.05 | 440.67 |
| 180 s | 133.20 | 437.38 |

À trois minutes, le RSS vaut **133.20 Mio contre 437.38 Mio**. Ce constat motive une investigation native/Graphite/allocateurs avant d’ajouter les coûts du ML et de la 3D ; aucune catégorie d’allocation n’a été attribuée par ce test.

Les conditions thermiques sont restées nominales, sans économie d’énergie ni troncature des échantillons. Le simulateur utilise le matériel du Mac M1 Pro ; ces chiffres ne constituent pas une mesure sur iPhone physique. Les durées de la session longue restent descriptives, puisque cet ordre n’a pas été inversé.

Preuves : [ancien](../benchmark/results/ab-soak-baseline.local.json), [nouveau](../benchmark/results/ab-soak-candidate.local.json), [repos ancien](../benchmark/results/ab-soak-baseline-execution.local.json), [repos nouveau](../benchmark/results/ab-soak-candidate-execution.local.json). Comparaison principale : [cinq scénarios dans les deux ordres](PERFORMANCE_AB_SIMULATOR.md).

## Mesures détaillées
Comparaison mesurée : **failed** selon le comparateur strict. Cette qualification conserve les échecs, les régressions et les validations média manquantes.

Ancien : @azzapp/react-native-skia-video 0.10.1, Skia 2.10.1. Nouveau : react-native-skia-webgpu-video 0.1.0-alpha.0, Skia 3.0.3.

Environnement : simulator, iPhone19,2, ios 27.0, React Native 0.86.2, release, horloge performance.now.

Ordre : ancien (SOAK) → nouveau (SOAK). Cette série ne constitue pas un ordre A/B puis B/A complet.

## Résultats regroupés

Médianes des répétitions réussies ; les effectifs restent visibles. Les six répétitions éventuelles sont regroupées depuis deux processus par version et ne constituent pas six démarrages indépendants. Pour les tailles alternées, chaque répétition pèse autant après calcul de sa propre médiane.

| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |
|---|---:|---:|---:|---:|
| Exports de tailles alternées | 3/3 · 3/3 | 603.67 / 839.45 | +39.1 % | 308.02 / 552.64 |

| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |
|---|---:|---:|---:|---:|
| Exports de tailles alternées 640×360 | 18 | 105.68 / 94.50 | -10.6 % | 118.13 / 106.59 |
| Exports de tailles alternées 1920×1080 | 18 | 291.59 / 236.61 | -18.9 % | 330.60 / 268.54 |
| Exports de tailles alternées 720×1280 | 18 | 165.43 / 138.84 | -16.1 % | 185.02 / 156.70 |

Le pipeline couvre décodage, dessin et encodage, avant lecture des métadonnées. Le total inclut aussi la vérification et la suppression du fichier. La lecture mesure des callbacks, pas les images effectivement affichées ni le temps GPU ; les valeurs p95 sont les médianes des bornes supérieures du p95 par répétition, pas un p95 global recalculé.

Les scénarios steady-playback mesurent une lecture continue sans seek ; ils ne remplacent pas les scénarios historiques de seek, boucle et maintien d’image. Un échec historique de seek reste un échec fonctionnel distinct.

Les pics RSS sont échantillonnés, donc des bornes inférieures du vrai maximum. Le RSS final suit la pause de stabilisation prévue par le scénario ; les caches peuvent survivre et le processus poursuit les scénarios suivants. Ces chiffres ne démontrent ni fuite ni absence de fuite.

## Qualification et limites

Budget demandé : 512 MiB. Application ancien : non disponible ; nouveau : oui.

Les compteurs de ressources propres à la nouvelle bibliothèque restent indisponibles sur l’ancienne. Ils ne sont jamais remplacés par zéro et ne servent pas à comparer la mémoire totale. Mémoire GPU totale et tas natif séparé : non mesurés lorsque les collecteurs sont absents.

### SOAK — failed

- Library-owned memory budget enforcement differs between backends; requested limits are identical, enforcement availability is recorded
- Decode/render/encode transport changed; record the intended change and do not describe CPU readback results as GPU-only
- Exports de tailles alternées : failed. rssBytes peak regression ; rssBytes grows after warmup; inspect retained resources

## Traçabilité

| Version / paire | Début UTC | Fin UTC | JSON SHA-256 |
|---|---|---|---|
| baseline / SOAK | 2026-10-06T20:26:49.570Z | 2026-10-06T20:30:14.811Z | bc1d3d168dad39860ab318fd711d46006f0883137dc4f01ef474d9437022051f |
| candidate / SOAK | 2026-10-06T20:34:48.228Z | 2026-10-06T20:38:01.662Z | e3b712bc0d98fee161bd54ddd89ba36562ca81b1b643c37c116aa12f4d829ba5 |

Les fenêtres sont celles enregistrées par chaque application. Les fichiers JSON conservent les échantillons, les conditions thermiques, les résultats des vérifications et les mesures par répétition.

Provenance complémentaire : benchmark/results/ab-provenance.local.json.

Hôte : {"recordedAt":"2026-10-06T16:17:55.791Z","model":"MacBookPro18,3","cpu":"Apple M1 Pro","memoryBytes":17179869184,"macOS":"27.0.1","macOSBuild":"26A434","source":"sysctl hw.model/hw.memsize/machdep.cpu.brand_string and sw_vers"}.
