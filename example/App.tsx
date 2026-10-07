import React, { useMemo, useState } from 'react';
import * as native from 'react-native';
import * as skia from 'react-native-skia';
import * as reanimated from 'react-native-reanimated';
import * as video from '../src';
import { createBenchmarkScreen } from '../benchmark/screen.mjs';
import manifest from './fixtures/manifest.json';
import device from './device.local.json';

const isAndroid = native.Platform.OS === 'android';
const helper = native.NativeModules.VideoBenchmarkHarness;
const details = helper?.getConstants?.() ?? helper ?? {};
const files = {
  outputPath: async (id: string, repetition: number, cycle: number) => {
    const directory = await helper.prepareOutputDirectory();
    return `${directory}/${id}-${repetition}-${cycle}.mp4`;
  },
  remove: (path: string) => helper.remove(path),
  stat: (path: string) => helper.stat(path),
  probe: (path: string) => helper.probe(path),
  writeResult: async (result: object) => {
    const name = `candidate-${Date.now()}.json`;
    const path = await helper.writeResult(JSON.stringify(result), name);
    console.log(`Benchmark result: ${path}`);
  },
};
const Screen = createBenchmarkScreen({ React, native, skia, reanimated, video,
  files, memory: { sample: () => helper.sampleMemory(),
    operatingConditions: () => helper.sampleOperatingConditions() } });

export default function App() {
  const [profile, setProfile] = useState<string | null>(details.benchmarkProfile ?? null);
  const [result, setResult] = useState<string | null>(null);
  const options = useMemo(() => ({
    profile, autorun: true, repetitions: details.benchmarkRepetitions ?? 3,
    caseIds: details.benchmarkCaseIds ?? undefined, memoryBudgetBytes: 512 * 1024 * 1024,
    memorySamplePeriodMs: 100,
    fixtureManifest: manifest, fixtureDirectory: details.fixtureDirectory,
    environment: { deviceId: isAndroid || details.executionTarget === 'simulator' ? details.deviceId : device.deviceId,
      benchmarkRunId: details.benchmarkRunId ?? undefined, processIdentifier: details.processIdentifier,
      deviceModel: details.deviceModel, executionTarget: details.executionTarget,
      platform: native.Platform.OS, osVersion: details.osVersion, reactNativeVersion: '0.86.2',
      measurementClock: 'performance.now',
      buildMode: __DEV__ ? 'debug' : 'release', displayRefreshRate: details.displayRefreshRate,
      thermalState: details.thermalState, powerMode: details.powerMode },
    backend: { name: 'react-native-skia-webgpu-video', version: '0.1.0-alpha.0',
      skiaVersion: '3.0.6', webgpuVersion: '0.12.1', paths: video.getVideoResourceStats().backend },
  }), [profile]);
  if (!helper) return <native.Text>Recompilez l’application de test : le module de mesure manque.</native.Text>;
  if (!profile) return <native.SafeAreaView style={{ flex: 1, padding: 20, gap: 16 }}>
    <native.Text style={{ fontSize: 24 }}>Skia WebGPU Tests</native.Text>
    <native.Text>Lecture, export, mémoire et fermeture des ressources sur cet appareil.</native.Text>
    {__DEV__ && <native.Text>{isAndroid ? 'Les tests de comparaison exigent le build Release Android.' : 'Les tests de comparaison exigent le build Release. Dans Xcode, choisissez Edit Scheme → Run → Build Configuration → Release.'}</native.Text>}
    {['smoke', 'full', 'soak'].map((value) => <native.Button key={value}
      title={value === 'smoke' ? 'Test rapide' : value === 'full' ? 'Tous les scénarios' : 'Test prolongé'}
      onPress={() => { setResult(null); setProfile(value); }} />)}
  </native.SafeAreaView>;
  return <native.SafeAreaView style={{ flex: 1 }}>
    <Screen options={options} onResult={(report: { cases: { status: string }[] }) => {
      setResult(`${report.cases.filter((entry) => entry.status === 'passed').length} réussis · ${report.cases.filter((entry) => entry.status === 'failed').length} échecs · ${report.cases.filter((entry) => entry.status === 'resource-limit').length} arrêtés par le budget · ${report.cases.filter((entry) => entry.status === 'skipped').length} non exécutés`);
    }} />
    {result && <>
      <native.Text style={{ padding: 12 }}>{result} — JSON sauvegardé dans les documents de l’application.</native.Text>
      <native.Button title="Retour aux profils" onPress={() => setProfile(null)} />
    </>}
  </native.SafeAreaView>;
}
