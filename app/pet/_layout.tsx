import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function PetLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.push,
      }}
    >
      {/* Creating a pet is a task, not a place — it gets a modal. */}
      <Stack.Screen name="new" options={routeTransition.modal} />
      <Stack.Screen name="[petId]" />
    </Stack>
  );
}
