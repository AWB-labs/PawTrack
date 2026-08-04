/**
 * The app's home. Four tabs, one custom-drawn bar.
 *
 * Why a custom bar rather than the default: the default tab bar can't express
 * the two things this app needs — a *live* count of what still needs doing
 * today, and a bar that reads as a floating object over content rather than a
 * chrome strip welded to the bottom. Both are in `PetalTabBar`.
 */

import { Tabs } from 'expo-router';
import React from 'react';

import { PetalTabBar } from '@/features/navigation/PetalTabBar';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: 'transparent' } }}
      tabBar={(props) => <PetalTabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: 'Today' }} />
      <Tabs.Screen name="pets" options={{ title: 'Pets' }} />
      <Tabs.Screen name="community" options={{ title: 'Community' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
