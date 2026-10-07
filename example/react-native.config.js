const path = require('path');
const root = path.resolve(__dirname, '..');
module.exports = {
  dependencies: {
    'react-native-skia-webgpu-video': { root },
    'react-native-skia': { root: path.join(root, 'node_modules/react-native-skia') },
    'react-native-webgpu': { root: path.join(root, 'node_modules/react-native-webgpu') },
    'react-native-reanimated': { root: path.join(root, 'node_modules/react-native-reanimated') },
    'react-native-worklets': { root: path.join(root, 'node_modules/react-native-worklets') },
    '@shopify/react-native-skia': { platforms: { ios: null, android: null } },
  },
};
