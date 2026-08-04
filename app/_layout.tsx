/**
 * Root route. Owns boot (fonts, session hydration, splash) and the top-level
 * navigation guards.
 *
 * The guard structure is the whole auth/RBAC story in one place. `Stack.Protected`
 * (expo-router v6) mounts a branch only while its `guard` is true, so there is no
 * imperative redirect race and no flash of the wrong screen:
 *
 *   locked          → biometric re-entry only
 *   unauthenticated → the auth branch
 *   authenticated   → onboarding until a profile + first pet exist, then the app
 *
 * Note there is deliberately no *global* role branch. A user is an owner of some
 * pets and a caregiver for others simultaneously, so role is resolved per pet
 * inside the app branch — never at the router level.
 */

import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect } from 'react';

import { useNotificationRouting } from '@/lib/notifications';
import { AppProviders } from '@/providers/AppProviders';
import { useSession } from '@/stores/session';
import { fontModules } from '@/theme/fonts';
import { routeTransition, useTheme } from '@/theme';
import { useOnboardingStatus } from '@/stores/ui';

SplashScreen.preventAutoHideAsync().catch(() => {
  /* already hidden — harmless on fast refresh */
});

// Keep the splash up a touch longer than strictly needed so the first paint is
// the finished UI rather than a half-laid-out screen.
SplashScreen.setOptions({ duration: 400, fade: true });

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontModules);
  const status = useSession((s) => s.status);
  const hydrate = useSession((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const ready = (fontsLoaded || !!fontError) && status !== 'loading';

  const onReady = useCallback(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    onReady();
  }, [onReady]);

  if (!ready) return null;

  return (
    <AppProviders>
      <RootNavigator />
    </AppProviders>
  );
}

function RootNavigator() {
  const theme = useTheme();
  const status = useSession((s) => s.status);
  const { needsProfile, needsFirstPet } = useOnboardingStatus();

  // Taps on a reminder deep-link straight to the thing that needs doing.
  useNotificationRouting();

  const isAuthed = status === 'authenticated';
  const isLocked = status === 'locked';
  const needsOnboarding = isAuthed && (needsProfile || needsFirstPet);

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.color.bg },
          ...routeTransition.push,
        }}
      >
        <Stack.Protected guard={isLocked}>
          <Stack.Screen name="lock" options={routeTransition.fade} />
        </Stack.Protected>

        <Stack.Protected guard={!isAuthed && !isLocked}>
          <Stack.Screen name="(auth)" options={routeTransition.fade} />
        </Stack.Protected>

        <Stack.Protected guard={needsOnboarding}>
          <Stack.Screen name="(onboarding)" options={routeTransition.fade} />
        </Stack.Protected>

        <Stack.Protected guard={isAuthed && !needsOnboarding}>
          <Stack.Screen name="(tabs)" options={routeTransition.fade} />
          <Stack.Screen name="pet" />
          <Stack.Screen name="record" options={routeTransition.modal} />
          <Stack.Screen name="community" />
          <Stack.Screen name="settings" />
        </Stack.Protected>

        {/* Invite links must resolve for signed-out users too — the accept
            screen handles "sign in first" itself rather than bouncing you to a
            login page that forgets why you came. */}
        <Stack.Screen name="invite/[code]" options={routeTransition.modal} />
        <Stack.Screen name="+not-found" options={{ title: 'Not found' }} />
      </Stack>
    </>
  );
}
