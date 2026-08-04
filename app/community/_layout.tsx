import { Stack } from 'expo-router';
import React from 'react';

import { routeTransition, useTheme } from '@/theme';

export default function CommunityLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.color.bg },
        ...routeTransition.push,
      }}
    >
      <Stack.Screen name="new" options={routeTransition.modal} />
      <Stack.Screen name="post/[postId]" />
      <Stack.Screen name="group/[groupId]" />
    </Stack>
  );
}
