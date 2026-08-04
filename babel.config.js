// SDK 54: babel-preset-expo automatically wires the Reanimated/Worklets plugin
// when react-native-reanimated + react-native-worklets are installed, and
// expo-router no longer needs its own Babel plugin. Keep this file minimal so
// we inherit those defaults instead of fighting them.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
  };
};
