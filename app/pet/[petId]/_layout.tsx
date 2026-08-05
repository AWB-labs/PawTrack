/**
 * A single pet's stack.
 *
 * This layout is where the dual-role model becomes concrete: it resolves the
 * viewer's membership for `petId` once and puts it in context, so every child
 * screen asks "what can I do *here*" rather than "what am I globally". A user
 * walking from their own dog into a pet they merely sit for crosses this
 * boundary and the whole subtree changes what it offers.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React from 'react';

import { PetScopeProvider } from '@/features/pets/PetScope';
import { routeTransition, useTheme } from '@/theme';

export default function PetStackLayout() {
  const t = useTheme();
  const { petId } = useLocalSearchParams<{ petId: string }>();

  return (
    <PetScopeProvider petId={petId}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.color.bg },
          ...routeTransition.push,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="edit" options={routeTransition.modal} />
        <Stack.Screen name="weight" />
        <Stack.Screen name="vaccinations" />
        <Stack.Screen name="vet-visits" />
        <Stack.Screen name="feeding" />
        <Stack.Screen name="medicine" />
        <Stack.Screen name="caregivers" />
        <Stack.Screen name="invite" options={routeTransition.modal} />
        <Stack.Screen name="activity" />
      </Stack>
    </PetScopeProvider>
  );
}
