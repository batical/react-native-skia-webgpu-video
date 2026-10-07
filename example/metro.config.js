const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const root = path.resolve(__dirname, '..');
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [path.join(root, 'node_modules')],
    // Packages such as Reanimated carry their own version of semver. Resolve
    // those nested dependencies before falling back to the shared workspace.
    disableHierarchicalLookup: false,
    extraNodeModules: { 'react-native-skia-webgpu-video': root },
    sourceExts: [...getDefaultConfig(__dirname).resolver.sourceExts, 'mjs'],
  },
});
