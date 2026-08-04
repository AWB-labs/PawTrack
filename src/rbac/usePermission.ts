/**
 * Petal — the React face of the RBAC model.
 *
 * `permissions.ts` answers `(membership, capability, now) → verdict` as a pure
 * function. This module is the only thing that knows the two pieces of context
 * a screen should never have to assemble by hand: *where the memberships live*
 * (the session store) and *what time it is*.
 *
 * Three deliberate choices:
 *
 *  1. **One shared clock.** Caregiver access is time-boxed, so a verdict that
 *     was true at render can be false a minute later. Every hook here reads a
 *     single module-level clock (a 30s tick plus an AppState wake-up), so the
 *     UI re-locks itself the moment a sitting window closes instead of lying
 *     until the next navigation. One timer for the whole app, not one per hook.
 *  2. **`explain()` ships with the verdict.** A denial nobody can interpret is
 *     just a greyed-out button, and greyed-out buttons are how sitters end up
 *     texting the owner "why can't I do anything?". Every denial therefore
 *     carries the callback that opens the sheet with the real reason and the
 *     real dates.
 *  3. **Defensive reads.** The session store hydrates asynchronously, so every
 *     hook must survive being called on the first frame, before sign-in
 *     resolves. "No membership" is a real, explainable state — not a crash.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import { showDenial, type DenialContext } from '@/rbac/DenialSheet';
import {
  effectiveCapabilities,
  evaluate,
  type Capability,
  type DenialReason,
  type Membership,
  type MembershipRole,
} from '@/rbac/permissions';
import { useSession } from '@/stores/session';

/* ------------------------------------------------------------------- types */

export type PermissionState = {
  allowed: boolean;
  /** Null while allowed. Drives every piece of denial copy in the app. */
  reason: DenialReason | null;
  /** The acting user's role *on this pet* — never a global role. */
  role: MembershipRole | null;
  membership: Membership | null;
  /**
   * Opens the themed denial sheet. No-op when allowed, so it is safe to wire
   * straight into `onPress={allowed ? doTheThing : explain}`. Pass extra
   * context (the pet's name, the owner's name) when the caller knows it — the
   * sheet's copy gets meaningfully warmer with it.
   */
  explain: (extra?: Partial<DenialContext>) => void;
};

/* ------------------------------------------------------------------- clock */

/** Coarse enough to be free, fine enough that a window flip feels immediate. */
const CLOCK_INTERVAL_MS = 30_000;

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: NativeEventSubscription | null = null;
let clockStamp = Date.now();

function tickClock(): void {
  clockStamp = Date.now();
  for (const listener of clockListeners) listener();
}

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    // Timers are throttled or frozen while backgrounded, so the first read
    // after a resume must come from the OS, not from our last tick.
    clockStamp = Date.now();
    clockTimer = setInterval(tickClock, CLOCK_INTERVAL_MS);
    appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') tickClock();
    });
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size > 0) return;
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    appStateSub?.remove();
    appStateSub = null;
  };
}

const getClockStamp = () => clockStamp;

/**
 * A `Date` that advances on the shared clock. Anything rendering a countdown,
 * a window progress bar or a "days left" label should use this so it stays
 * honest without owning a timer.
 */
export function useNow(): Date {
  const stamp = useSyncExternalStore(subscribeClock, getClockStamp, getClockStamp);
  return useMemo(() => new Date(stamp), [stamp]);
}

/* -------------------------------------------------------------- membership */

const NO_MEMBERSHIPS: readonly Membership[] = [];

/**
 * The store only ever holds the signed-in user's own memberships, but we still
 * prefer an exact `(petId, userId)` hit: it keeps the lookup correct if a
 * future screen ever preloads someone else's row, and it degrades to a pet
 * match while the profile is still hydrating.
 */
function findMembership(
  list: readonly Membership[],
  petId: string | null | undefined,
  userId: string | undefined,
): Membership | null {
  if (!petId) return null;
  let petMatch: Membership | null = null;
  for (const m of list) {
    if (m.petId !== petId) continue;
    if (userId && m.userId === userId) return m;
    if (!petMatch) petMatch = m;
  }
  return petMatch;
}

/** Every membership the signed-in user holds, across all pets. */
export function useMemberships(): readonly Membership[] {
  const memberships = useSession((s) => s.memberships);
  return Array.isArray(memberships) ? memberships : NO_MEMBERSHIPS;
}

/** The signed-in user's membership for one pet, or null if they hold none. */
export function useMembership(petId: string | null | undefined): Membership | null {
  const list = useMemberships();
  const userId = useSession((s) => s.user?.id);
  return useMemo(() => findMembership(list, petId, userId), [list, petId, userId]);
}

/** `'owner' | 'caregiver' | null` — always scoped to a single pet. */
export function useMyRole(petId: string | null | undefined): MembershipRole | null {
  return useMembership(petId)?.role ?? null;
}

export function useIsOwner(petId: string | null | undefined): boolean {
  return useMyRole(petId) === 'owner';
}

/* ------------------------------------------------------------ permissions */

/**
 * The hook every screen uses:
 *
 *   const { allowed, explain } = usePermission('feeding.log', petId);
 *   <Button onPress={allowed ? logMeal : explain} />
 */
export function usePermission(
  capability: Capability,
  petId: string | null | undefined,
): PermissionState {
  const membership = useMembership(petId);
  const now = useNow();

  const verdict = useMemo(
    () => evaluate(membership, capability, now),
    [membership, capability, now],
  );

  const explain = useCallback(
    (extra?: Partial<DenialContext>) => {
      if (verdict.allowed) return;
      showDenial(verdict.reason, {
        capability,
        petId: petId ?? null,
        membership,
        ...extra,
      });
    },
    [verdict, capability, petId, membership],
  );

  return useMemo(
    () => ({
      allowed: verdict.allowed,
      reason: verdict.allowed ? null : verdict.reason,
      role: verdict.role,
      membership,
      explain,
    }),
    [verdict, membership, explain],
  );
}

/**
 * Batched form. One membership lookup and one clock read for the whole set —
 * use this when a screen gates six things at once (a detail header with edit,
 * delete, log, share, invite and export) instead of calling `usePermission`
 * six times.
 */
export function usePermissions<C extends Capability>(
  capabilities: readonly C[],
  petId: string | null | undefined,
): Record<C, boolean> {
  const membership = useMembership(petId);
  const now = useNow();
  // Callers pass array literals, so identity churns every render. The joined
  // key is the real dependency; `capabilities` is read inside the factory.
  const key = capabilities.join('|');

  return useMemo(() => {
    const result = {} as Record<C, boolean>;
    for (const capability of capabilities) {
      result[capability] = evaluate(membership, capability, now).allowed;
    }
    return result;
  }, [key, membership, now]);
}

/**
 * Everything the user can actually do with this pet right now, baseline grants
 * and time window included. This is what `AccessSummaryCard` renders as the
 * "You can" column.
 */
export function useEffectiveCapabilities(petId: string | null | undefined): Capability[] {
  const membership = useMembership(petId);
  const now = useNow();
  return useMemo(() => effectiveCapabilities(membership, now), [membership, now]);
}
