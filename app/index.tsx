/**
 * Boot route. The root layout's guards decide which branch is mounted, so all
 * this has to do is point at the entry screen of whichever branch won. Rendering
 * a `<Redirect>` (rather than calling `router.replace` in an effect) means the
 * decision happens during render and never flashes an intermediate screen.
 */

import { Redirect } from 'expo-router';
import React from 'react';

import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';

export default function Index() {
  const status = useSession((s) => s.status);
  const hasSeenWelcome = usePreferences((s) => s.hasSeenWelcome);

  if (status === 'locked') return <Redirect href="/lock" />;
  if (status !== 'authenticated') {
    return <Redirect href={hasSeenWelcome ? '/sign-in' : '/welcome'} />;
  }
  return <Redirect href="/(tabs)" />;
}
