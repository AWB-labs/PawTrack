/**
 * Boot route. The root layout's guards decide which branch is mounted, so all
 * this has to do is point at the entry screen of whichever branch won. Rendering
 * a `<Redirect>` (rather than calling `router.replace` in an effect) means the
 * decision happens during render and never flashes an intermediate screen.
 */

import { Redirect } from 'expo-router';
import React from 'react';

import { useNeedsAgreement } from '@/data/queries/useModeration';
import { toHref } from '@/lib/deeplinks';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';

export default function Index() {
  const status = useSession((s) => s.status);
  const hasSeenWelcome = usePreferences((s) => s.hasSeenWelcome);
  const needsAgreement = useNeedsAgreement();

  if (status === 'locked') return <Redirect href="/lock" />;
  if (status !== 'authenticated') {
    return <Redirect href={hasSeenWelcome ? '/sign-in' : '/welcome'} />;
  }
  // The tabs branch isn't mounted while the agreement gate is up, so pointing
  // at it here would land on nothing at all.
  if (needsAgreement) return <Redirect href={toHref('/accept-terms')} />;
  return <Redirect href="/(tabs)" />;
}
