/**
 * Onboarding branch.
 *
 * Gestures are disabled between steps: this is a short guided flow with its own
 * back control and a visible progress rail, and an edge-swipe that silently
 * undoes a step you just completed is disorienting. The steps themselves are
 * progressive — we ask for a photo *after* there's a name to attach it to, and
 * for notification permission only once there's actually something to remind
 * about.
 */

import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function OnboardingLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: { backgroundColor: t.color.bg },
        animation: 'slide_from_right',
        animationDuration: t.motion.duration.page,
      }}
    >
      <Stack.Screen name="profile" options={routeTransition.fade} />
      <Stack.Screen name="first-pet" />
      <Stack.Screen name="reminders" />
      <Stack.Screen name="done" options={routeTransition.fade} />
    </Stack>
  );
}
