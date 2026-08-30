/**
 * Auth branch. Header is hidden throughout — each auth screen draws its own
 * back affordance so the visual weight stays with the content, not a chrome bar.
 */

import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function AuthLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.push,
      }}
    >
      <Stack.Screen name="welcome" options={routeTransition.fade} />
      <Stack.Screen name="agreement" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="forgot-password" options={routeTransition.formSheet} />
    </Stack>
  );
}
