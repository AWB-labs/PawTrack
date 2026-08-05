import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function SettingsLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.push,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="appearance" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="account" />
      <Stack.Screen name="about" />
    </Stack>
  );
}
