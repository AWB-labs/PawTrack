/**
 * The agreement gate.
 *
 * The half of Guideline 1.2 that the sign-up form alone cannot satisfy: every
 * account that already existed when these terms shipped, and every account
 * created against an older version, meets this before it reaches the app. The
 * router mounts it on `termsVersion < TERMS_VERSION` and unmounts it the instant
 * `acceptTerms` writes the new number back into the session store.
 *
 * Declining signs you out rather than doing nothing. Somebody who will not agree
 * to the rules of a community is not in a broken state — they are a person who
 * would like to leave, and the button should let them.
 */

import React, { useCallback } from 'react';

import { useAcceptTerms } from '@/data/queries/useModeration';
import { TERMS_VERSION } from '@/features/legal/agreement';
import { AgreementScreen } from '@/features/legal/AgreementScreen';
import { usePreferences } from '@/stores/preferences';
import { useCurrentUser, useSession } from '@/stores/session';

export default function LegalAgreementScreen() {
  const user = useCurrentUser();
  const accept = useAcceptTerms();
  const signOut = useSession((s) => s.signOut);
  const acceptOnDevice = usePreferences((s) => s.acceptTerms);

  // Somebody who has never agreed is being asked; somebody on an older version
  // is being asked *again*, and being told so is the difference between a gate
  // that feels like process and one that feels like a bug.
  const returning = (user?.termsVersion ?? 0) > 0;

  const agree = useCallback(() => {
    acceptOnDevice(TERMS_VERSION);
    accept.mutate(TERMS_VERSION);
  }, [accept, acceptOnDevice]);

  const decline = useCallback(() => {
    void signOut();
  }, [signOut]);

  return (
    <AgreementScreen
      title={returning ? 'Our rules have changed' : 'One thing before you start'}
      subtitle={
        returning
          ? 'We’ve updated the community rules. Have a read — it won’t take long.'
          : 'Furry Tracker has a community feed, and these are the rules for it.'
      }
      confirmLabel="I agree"
      declineLabel="Sign out instead"
      onAgree={agree}
      onDecline={decline}
      busy={accept.isPending}
      testID="legal-agreement"
    />
  );
}
