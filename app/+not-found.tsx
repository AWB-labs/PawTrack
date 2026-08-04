/**
 * 404. Reached mainly from a stale or malformed deep link, so the copy assumes
 * that rather than blaming the user for "navigating incorrectly".
 */

import { router, Stack } from 'expo-router';
import React from 'react';

import Screen from '@/ui/Screen';
import EmptyState from '@/ui/EmptyState';
import { ErrorNotFound } from '@/ui/illustrations';

export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen center>
        <EmptyState
          illustration={<ErrorNotFound size={190} />}
          title="We couldn't find that"
          body="This link may have expired, or the pet it pointed to isn't shared with you any more."
          action={{ label: 'Back to Today', onPress: () => router.replace('/(tabs)') }}
          secondaryAction={{ label: 'Go back', onPress: () => router.back() }}
        />
      </Screen>
    </>
  );
}
