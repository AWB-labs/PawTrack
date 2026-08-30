/**
 * The agreement, before the form.
 *
 * The welcome screen sends both of its buttons through here, and this screen
 * remembers the answer on the device — so somebody who agrees, backs out, and
 * comes back a week later meets their form rather than the rules again. What it
 * deliberately does *not* do is remember the answer for the *account*: that is
 * recorded server-side by the gate in `(legal)`, the moment there is an account
 * to record it against.
 *
 * `next` decides where agreeing lands you. It is validated rather than trusted,
 * because a route parameter that becomes a navigation target is a redirect the
 * user did not choose if you let anything through it.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback } from 'react';

import { TERMS_VERSION } from '@/features/legal/agreement';
import { toHref } from '@/lib/deeplinks';
import { AgreementScreen } from '@/features/legal/AgreementScreen';
import { usePreferences } from '@/stores/preferences';

type Destination = '/sign-up' | '/sign-in';

export default function AuthAgreementScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string }>();
  const acceptOnDevice = usePreferences((s) => s.acceptTerms);

  const next: Destination = params.next === 'sign-in' ? '/sign-in' : '/sign-up';

  const agree = useCallback(() => {
    acceptOnDevice(TERMS_VERSION);
    router.replace(toHref(next));
  }, [acceptOnDevice, next, router]);

  const decline = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref('/welcome'));
  }, [router]);

  return (
    <AgreementScreen
      title="Before you join us"
      subtitle="Furry Tracker has a community feed. These are the rules for it — please read them."
      confirmLabel={next === '/sign-in' ? 'I agree — sign me in' : 'I agree — create my account'}
      declineLabel="Not right now"
      onAgree={agree}
      onDecline={decline}
      showBack
      onBack={decline}
      testID="auth-agreement"
    />
  );
}
