/**
 * The legal branch.
 *
 * Mounted by the root navigator whenever a signed-in account is behind the
 * current terms, and nothing else. There is exactly one screen in it and no way
 * out except agreeing or signing out — which is the point: a gate with a back
 * gesture is not a gate.
 */

import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function LegalLayout() {
  const t = useTheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.fade,
        // After the spread, not before: `routeTransition.fade` carries its own
        // gesture setting and would otherwise reopen the door this closes.
        gestureEnabled: false,
      }}
    >
      <Stack.Screen name="accept-terms" />
    </Stack>
  );
}
