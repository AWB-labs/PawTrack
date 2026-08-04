/**
 * Create/edit forms for the sub-entities that hang off a pet (a vaccination, a
 * dose, an appointment…).
 *
 * They live in their own group as modals rather than as routes under
 * `pet/[petId]/` because they're *tasks*, not destinations: you open one, finish
 * it, and land back where you were. Each takes `petId` plus an optional `id` — a
 * missing `id` means create, a present one means edit, so one screen serves both
 * and the two can never drift apart.
 */

import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function RecordLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.modal,
      }}
    >
      <Stack.Screen name="weight" />
      <Stack.Screen name="vaccination" />
      <Stack.Screen name="vet-visit" />
      <Stack.Screen name="feeding-schedule" />
      <Stack.Screen name="medicine" />
      <Stack.Screen name="appointment" />
      <Stack.Screen name="document" />
    </Stack>
  );
}
