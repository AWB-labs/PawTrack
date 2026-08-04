/**
 * Petal — transient UI state.
 *
 * The things that decide *what the app is showing*, as opposed to what it knows:
 * which pet is in scope, which day the Today screen is parked on, what the
 * community feed is filtered to, and how far through onboarding this account is.
 *
 * None of it is server state, so none of it belongs in React Query. Almost none
 * of it is worth persisting either — the exception is the onboarding marker,
 * which has to survive a reload or a half-finished sign-up sends the user round
 * the loop again. The active pet is mirrored into `preferences.lastActivePetId`
 * instead, because "which pet was I looking at" is a device preference that also
 * needs to be correct on the very first frame after a cold start.
 *
 * Everything here resets when the signed-in user changes. A shared iPad that
 * opens on the previous person's dog is a small privacy failure and a large
 * confusion.
 */

import { useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { FeedScope } from '@/data/adapter';
import { usePets } from '@/data/queries/usePets';
import type { DateOnly, ID, Pet } from '@/data/types';
import { fromDateOnly, toDateOnly } from '@/lib/date';
import { getPreferences, usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';

/* -------------------------------------------------------------------- types */

/**
 * The feed's filter, in UI terms. Kept as a discriminated union rather than the
 * adapter's loose `FeedScope` so a screen can switch on it exhaustively and the
 * segmented control can't produce a nonsense combination.
 */
export type FeedScopeSelection =
  | { kind: 'all' }
  | { kind: 'group'; groupId: ID }
  | { kind: 'pet'; petId: ID }
  | { kind: 'author'; authorId: ID };

export type OnboardingStep = 'profile' | 'firstPet' | 'reminders' | 'done';

export type OnboardingProgress = {
  /** Progress belongs to an account, not to a device. */
  userId: ID | null;
  step: OnboardingStep;
  completedAt: string | null;
};

export type UIState = {
  /** The pet every "add a weight"-style shortcut applies to. */
  activePetId: ID | null;
  setActivePetId: (petId: ID | null) => void;

  /** Today screen's cursor. Always a local `YYYY-MM-DD`, never a timestamp. */
  selectedDate: DateOnly;
  setSelectedDate: (date: DateOnly) => void;
  stepSelectedDate: (days: number) => void;
  resetSelectedDate: () => void;

  feedScope: FeedScopeSelection;
  setFeedScope: (scope: FeedScopeSelection) => void;

  onboarding: OnboardingProgress;
  setOnboardingStep: (step: OnboardingStep) => void;
  completeOnboarding: () => void;
  restartOnboarding: () => void;

  /** Called when the signed-in account changes. */
  resetForUser: (userId: ID | null) => void;
};

/* ---------------------------------------------------------------- constants */

export const ALL_POSTS: FeedScopeSelection = { kind: 'all' };

const today = (): DateOnly => toDateOnly(new Date());

const freshOnboarding = (userId: ID | null): OnboardingProgress => ({
  userId,
  step: 'profile',
  completedAt: null,
});

/** Translate the UI's selection into the argument the adapter takes. */
export function toFeedScope(selection: FeedScopeSelection): FeedScope {
  switch (selection.kind) {
    case 'group':
      return { groupId: selection.groupId };
    case 'pet':
      return { petId: selection.petId };
    case 'author':
      return { authorId: selection.authorId };
    case 'all':
    default:
      return {};
  }
}

/* -------------------------------------------------------------------- store */

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      activePetId: null,

      setActivePetId: (petId) => {
        if (get().activePetId === petId) return;
        set({ activePetId: petId });
        // Mirrored so a cold start opens on the pet you were last with.
        getPreferences().setLastActivePetId(petId);
      },

      selectedDate: today(),

      setSelectedDate: (date) => set({ selectedDate: date }),

      stepSelectedDate: (days) => {
        const base = fromDateOnly(get().selectedDate) ?? new Date();
        base.setDate(base.getDate() + days);
        set({ selectedDate: toDateOnly(base) });
      },

      resetSelectedDate: () => set({ selectedDate: today() }),

      feedScope: ALL_POSTS,

      setFeedScope: (feedScope) => set({ feedScope }),

      onboarding: freshOnboarding(null),

      setOnboardingStep: (step) =>
        set((state) => ({
          onboarding: {
            ...state.onboarding,
            userId: state.onboarding.userId ?? useSession.getState().user?.id ?? null,
            step,
          },
        })),

      completeOnboarding: () =>
        set({
          onboarding: {
            userId: useSession.getState().user?.id ?? null,
            step: 'done',
            completedAt: new Date().toISOString(),
          },
        }),

      restartOnboarding: () => set({ onboarding: freshOnboarding(useSession.getState().user?.id ?? null) }),

      resetForUser: (userId) =>
        set((state) => ({
          activePetId: null,
          selectedDate: today(),
          feedScope: ALL_POSTS,
          // The privacy concern this guards against is a DIFFERENT account's
          // progress leaking onto this one's screen — the stated "shared
          // iPad" case. Signing out (userId === null) isn't that: it's the
          // same account, mid-transition, about to sign back in. Resetting
          // here too meant every sign-out wiped the 'done' marker, so the
          // very next sign-in — same person, same account — read as a fresh
          // signup and sent them through onboarding again. Only a genuinely
          // different, non-null user gets a clean slate.
          onboarding:
            userId === null || state.onboarding.userId === userId
              ? state.onboarding
              : freshOnboarding(userId),
        })),
    }),
    {
      name: 'petal.ui.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      // Only the marker earns a place on disk; the rest is meant to be forgotten.
      partialize: (state) => ({ onboarding: state.onboarding }),
    },
  ),
);

/* ------------------------------------------------------------ side effects */

// Switching accounts wipes the view, not the data.
useSession.subscribe((state, previous) => {
  const next = state.user?.id ?? null;
  if (next === (previous.user?.id ?? null)) return;
  useUI.getState().resetForUser(next);
});

/**
 * Preferences rehydrate a beat after this module evaluates, so the last active
 * pet is adopted when it lands — and only if the user hasn't already picked one
 * in the meantime.
 */
function adoptLastActivePet(): void {
  const stored = getPreferences().lastActivePetId;
  if (stored && !useUI.getState().activePetId) useUI.setState({ activePetId: stored });
}

if (usePreferences.persist.hasHydrated()) {
  adoptLastActivePet();
} else {
  let off: (() => void) | undefined;
  off = usePreferences.persist.onFinishHydration(() => {
    off?.();
    adoptLastActivePet();
  });
}

/* ---------------------------------------------------------------- selectors */

export const getUI = (): UIState => useUI.getState();

export function useActivePetId(): ID | null {
  return useUI((s) => s.activePetId);
}

/**
 * The pet in scope, resolved against the pet list. Falls back to the first pet
 * so screens that need "a pet" always have one — a household with pets should
 * never render an empty state because a stale id pointed at a deleted dog.
 */
export function useActivePet(): Pet | null {
  const activePetId = useActivePetId();
  const { data: pets } = usePets();

  return useMemo(() => {
    if (!pets || pets.length === 0) return null;
    return pets.find((pet) => pet.id === activePetId) ?? pets[0] ?? null;
  }, [pets, activePetId]);
}

export function useSelectedDate(): DateOnly {
  return useUI((s) => s.selectedDate);
}

export function useFeedScope(): FeedScope {
  const selection = useUI((s) => s.feedScope);
  return useMemo(() => toFeedScope(selection), [selection]);
}

export function useFeedScopeSelection(): FeedScopeSelection {
  return useUI((s) => s.feedScope);
}

/* -------------------------------------------------------------- onboarding */

export type OnboardingStatus = {
  step: OnboardingStep;
  /** No display name yet — an OAuth account can land here with a blank profile. */
  needsProfile: boolean;
  /** Signed in, no pets, no memberships, and hasn't chosen to skip. */
  needsFirstPet: boolean;
  isComplete: boolean;
};

/**
 * The router's onboarding guard. Deliberately conservative: while the pet list
 * is still loading, `needsFirstPet` stays false so a returning owner never sees
 * a flash of "add your first pet" on the way to their household.
 */
export function useOnboardingStatus(): OnboardingStatus {
  const user = useSession((s) => s.user);
  const status = useSession((s) => s.status);
  const memberships = useSession((s) => s.memberships);
  const onboarding = useUI((s) => s.onboarding);
  const { data: pets } = usePets();

  return useMemo(() => {
    const authenticated = status === 'authenticated';
    const mine = onboarding.userId === null || onboarding.userId === (user?.id ?? null);
    const isComplete = mine && onboarding.step === 'done';

    return {
      step: mine ? onboarding.step : 'profile',
      needsProfile: authenticated && !user?.displayName.trim(),
      needsFirstPet:
        authenticated && !isComplete && pets !== undefined && pets.length === 0 && memberships.length === 0,
      isComplete,
    };
  }, [status, user, memberships, onboarding, pets]);
}

export default useUI;
