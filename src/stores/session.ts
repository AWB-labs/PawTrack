/**
 * Petal — session store.
 *
 * The one place that knows *who is acting*. Everything downstream — the router
 * guards, `usePermission`, every React Query hook — reads from here, which is
 * why this store has three properties it guards carefully:
 *
 *  1. **`actorContext` is memoised.** It is the argument to every adapter call
 *     and therefore a dependency of every query. Handing out a fresh
 *     `{ userId, memberships }` on each session emission would re-run the whole
 *     app's data layer on a silent token refresh, so a new object is only
 *     created when the user or a membership genuinely changed.
 *  2. **Only non-sensitive crumbs are persisted.** Tokens live in the adapter
 *     (SecureStore / AsyncStorage under Supabase's own key) and never pass
 *     through here. What we persist is a name and an avatar, purely so the lock
 *     screen can say "Welcome back, Maya" on the very first frame instead of
 *     flashing a generic shell.
 *  3. **`locked` is a first-class status, not a modal.** Biometric re-entry is
 *     a router branch (`app/lock`), so a locked app cannot render a pet's
 *     medical records behind a sheet that a screenshot or an app-switcher
 *     preview would expose.
 *
 * Sign-in wrappers rethrow. Screens own their own error presentation (inline
 * field errors read better than a toast on an auth form), so this store sets
 * status and gets out of the way.
 */

import { useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { adapter } from '@/data';
import type {
  ActorContext,
  OAuthProvider,
  SignInInput,
  SignUpInput,
} from '@/data/adapter';
import type { ID, Session, User } from '@/data/types';
import biometrics, { type BiometricResult } from '@/lib/biometrics';
import { logError } from '@/lib/errors';
import type { Membership } from '@/rbac/permissions';
import { getPreferences, usePreferences } from '@/stores/preferences';

/* -------------------------------------------------------------------- types */

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'locked';

/** Which wrapper is in flight, so buttons can show progress without local state. */
export type SessionAction = 'hydrate' | 'signIn' | 'signUp' | 'oauth' | 'signOut' | 'unlock';

/** The crumbs that survive a restart. Never a token, never a membership grant. */
export type LastKnownUser = {
  userId: ID;
  displayName: string;
  avatarUrl: string | null;
};

export type SessionState = {
  user: User | null;
  /** Every membership this user holds — the dual-role source of truth. */
  memberships: Membership[];
  status: SessionStatus;
  /**
   * Stable identity while the user and their memberships are unchanged. Null
   * whenever nobody is signed in, which is what every query hook gates on.
   */
  actorContext: ActorContext | null;
  pending: SessionAction | null;
  /** True once boot has consulted the adapter, successfully or not. */
  hydrated: boolean;
  lastKnown: LastKnownUser | null;

  hydrate: () => Promise<void>;
  signIn: (input: SignInInput) => Promise<Session>;
  signUp: (input: SignUpInput) => Promise<Session>;
  signInWithOAuth: (provider: OAuthProvider) => Promise<Session>;
  signOut: () => Promise<void>;
  /** Biometric re-entry. `lock()` is instant; `unlock()` prompts. */
  lock: () => void;
  unlock: (options?: { reason?: string }) => Promise<BiometricResult>;
  /** Re-reads memberships after accepting an invite or being granted access. */
  refreshMemberships: () => Promise<void>;
  /** Applied after a profile edit so the header updates without a round trip. */
  setUser: (user: User) => void;
  /** Adapter-driven session changes land here. Exported for the boot listener. */
  applySession: (session: Session | null, options?: { keepLocked?: boolean }) => void;
};

/* ---------------------------------------------------------------- constants */

const EMPTY_MEMBERSHIPS: Membership[] = [];

/** Away for longer than this with the lock armed and Petal asks again. */
const RELOCK_AFTER_MS = 60_000;

/** Boot must not hang on a slow disk read of the preferences store. */
const PREFERENCES_WAIT_MS = 1_500;

/* ------------------------------------------------------------------ helpers */

/** Cheap identity for a membership — everything a verdict can turn on. */
const fingerprint = (m: Membership): string =>
  `${m.id}:${m.role}:${m.status}:${m.startsAt ?? ''}:${m.endsAt ?? ''}:${m.grants.join(',')}`;

function sameMemberships(a: readonly Membership[], b: readonly Membership[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (fingerprint(a[i]!) !== fingerprint(b[i]!)) return false;
  }
  return true;
}

function sameUser(a: User | null, b: User): boolean {
  return (
    a !== null &&
    a.id === b.id &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.avatarUrl === b.avatarUrl &&
    a.bio === b.bio
  );
}

/** Reuse the previous context whenever nothing a query depends on has moved. */
function nextActor(previous: ActorContext | null, session: Session): ActorContext {
  if (previous && previous.userId === session.user.id && sameMemberships(previous.memberships, session.memberships)) {
    return previous;
  }
  return { userId: session.user.id, memberships: session.memberships };
}

const crumbsFor = (user: User): LastKnownUser => ({
  userId: user.id,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
});

/**
 * Preferences persist asynchronously, and the lock decision depends on them. A
 * race here means the app opens straight into a household it was told to lock,
 * so boot waits — briefly, and never forever.
 */
async function preferencesReady(): Promise<void> {
  if (usePreferences.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const off = usePreferences.persist.onFinishHydration(() => {
      off();
      finish();
    });
    setTimeout(finish, PREFERENCES_WAIT_MS);
  });
}

/* ----------------------------------------------------------- side listeners */

let hydratePromise: Promise<void> | null = null;
let adapterSub: (() => void) | null = null;
let lifecycleSub: NativeEventSubscription | null = null;
let leftAt: number | null = null;

/** Out-of-band auth changes: a refresh, a sign-out on another device, an invite. */
function armAdapterListener(): void {
  if (adapterSub) return;
  adapterSub = adapter.onSessionChange((session) => {
    // A background token refresh must never dissolve the lock screen.
    useSession.getState().applySession(session, { keepLocked: true });
  });
}

/**
 * Re-lock after a real absence, not after a glance at the notification shade.
 * The grace period is what keeps the lock from becoming the thing people turn
 * off within a day.
 */
function armLifecycleLock(): void {
  if (lifecycleSub) return;
  lifecycleSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background') {
      leftAt = Date.now();
      return;
    }
    if (state !== 'active') return;

    const away = leftAt === null ? 0 : Date.now() - leftAt;
    leftAt = null;
    const store = useSession.getState();
    if (away >= RELOCK_AFTER_MS && store.status === 'authenticated' && getPreferences().biometricLock) {
      store.lock();
    }
  });
}

/* -------------------------------------------------------------------- store */

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      memberships: EMPTY_MEMBERSHIPS,
      status: 'loading',
      actorContext: null,
      pending: null,
      hydrated: false,
      lastKnown: null,

      applySession: (session, options) => {
        if (!session) {
          set({
            user: null,
            memberships: EMPTY_MEMBERSHIPS,
            actorContext: null,
            status: 'unauthenticated',
            lastKnown: null,
          });
          return;
        }

        const state = get();
        const actorContext = nextActor(state.actorContext, session);
        const user = sameUser(state.user, session.user) && state.user ? state.user : session.user;
        const keepLocked = options?.keepLocked === true && state.status === 'locked';

        set({
          user,
          memberships: actorContext.memberships,
          actorContext,
          status: keepLocked ? 'locked' : 'authenticated',
          lastKnown: crumbsFor(user),
        });
      },

      hydrate: async () => {
        if (hydratePromise) return hydratePromise;

        hydratePromise = (async () => {
          set({ pending: 'hydrate' });
          armAdapterListener();
          armLifecycleLock();

          try {
            const [session] = await Promise.all([adapter.getSession(), preferencesReady()]);
            if (!session) {
              get().applySession(null);
              return;
            }

            get().applySession(session);

            // Decided once, here, so the app never paints a pet's records for a
            // frame before the lock screen mounts over them.
            if (getPreferences().biometricLock && (await biometrics.canUseBiometrics())) {
              set({ status: 'locked' });
            }
          } catch (error) {
            // A boot that can't read the session is a signed-out boot, not a
            // crash — the user signs in again and nothing is lost.
            logError('session.hydrate', error);
            get().applySession(null);
          } finally {
            set({ hydrated: true, pending: null });
          }
        })();

        return hydratePromise;
      },

      signIn: async (input) => {
        set({ pending: 'signIn' });
        try {
          const session = await adapter.signIn(input);
          get().applySession(session);
          return session;
        } catch (error) {
          logError('session.signIn', error);
          throw error;
        } finally {
          set({ pending: null });
        }
      },

      signUp: async (input) => {
        set({ pending: 'signUp' });
        try {
          const session = await adapter.signUp(input);
          get().applySession(session);
          return session;
        } catch (error) {
          logError('session.signUp', error);
          throw error;
        } finally {
          set({ pending: null });
        }
      },

      signInWithOAuth: async (provider) => {
        set({ pending: 'oauth' });
        try {
          const session = await adapter.signInWithOAuth(provider);
          get().applySession(session);
          return session;
        } catch (error) {
          logError('session.signInWithOAuth', error);
          throw error;
        } finally {
          set({ pending: null });
        }
      },

      signOut: async () => {
        set({ pending: 'signOut' });
        try {
          await adapter.signOut();
        } catch (error) {
          // Whatever the server says, the person in front of the phone asked to
          // be signed out. Local state wins.
          logError('session.signOut', error);
        } finally {
          get().applySession(null);
          set({ pending: null });
        }
      },

      lock: () => {
        const { status, user } = get();
        if (!user || status === 'unauthenticated') return;
        set({ status: 'locked' });
      },

      unlock: async (options) => {
        const { user } = get();
        if (!user) {
          set({ status: 'unauthenticated' });
          return { ok: true };
        }

        set({ pending: 'unlock' });
        try {
          // Enrollment can disappear between sessions (a reset phone, a removed
          // fingerprint). Failing open beats locking someone out of their own
          // dog's medication schedule — and we turn the preference off so the
          // settings screen tells the truth.
          if (!(await biometrics.canUseBiometrics())) {
            usePreferences.getState().setBiometricLock(false);
            set({ status: 'authenticated' });
            return { ok: true };
          }

          const result = await biometrics.authenticate({
            reason: options?.reason ?? 'Unlock your pets’ records',
          });
          if (result.ok) set({ status: 'authenticated' });
          return result;
        } finally {
          set({ pending: null });
        }
      },

      refreshMemberships: async () => {
        const ctx = get().actorContext;
        if (!ctx) return;
        try {
          const memberships = await adapter.listMyMemberships(ctx);
          if (sameMemberships(ctx.memberships, memberships)) return;
          const actorContext: ActorContext = { userId: ctx.userId, memberships };
          set({ actorContext, memberships });
        } catch (error) {
          logError('session.refreshMemberships', error);
        }
      },

      setUser: (user) => {
        const state = get();
        if (!state.actorContext || state.actorContext.userId !== user.id) return;
        if (sameUser(state.user, user)) return;
        set({ user, lastKnown: crumbsFor(user) });
      },
    }),
    {
      name: 'petal.session.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      // Tokens and grants stay out of plain storage; a display name does not
      // buy an attacker anything and buys the lock screen a lot.
      partialize: (state) => ({ lastKnown: state.lastKnown }),
    },
  ),
);

/* ---------------------------------------------------------------- selectors */

/** Non-reactive read, for imperative code (deep links, notification handlers). */
export const getSession = (): SessionState => useSession.getState();

/**
 * The actor, in the exact shape query hooks want. `ctx` is never null so
 * `queryFn` stays assertion-free; `ready` is what `enabled` gates on.
 */
export type Actor = {
  ctx: ActorContext;
  ready: boolean;
  userId: ID;
};

export const ANONYMOUS_ACTOR: ActorContext = { userId: '', memberships: EMPTY_MEMBERSHIPS };

const actorFrom = (actorContext: ActorContext | null): Actor => ({
  ctx: actorContext ?? ANONYMOUS_ACTOR,
  ready: actorContext !== null,
  userId: actorContext?.userId ?? '',
});

export function useActor(): Actor {
  const actorContext = useSession((s) => s.actorContext);
  return useMemo(() => actorFrom(actorContext), [actorContext]);
}

export const getActor = (): Actor => actorFrom(useSession.getState().actorContext);

export function useCurrentUser(): User | null {
  return useSession((s) => s.user);
}

export function useSessionStatus(): SessionStatus {
  return useSession((s) => s.status);
}

export function useIsAuthenticated(): boolean {
  return useSession((s) => s.status === 'authenticated');
}

export default useSession;
