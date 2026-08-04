/**
 * Petal — React Query runtime.
 *
 * The client's defaults are the app's behaviour policy, so they are written out
 * rather than inherited:
 *
 *  · **Retries are earned, not automatic.** A `PermissionError` or any 4xx is a
 *    settled answer — retrying it three times only delays the explanation and,
 *    on the auth path, can trip rate limits. `lib/errors.ts` already classifies
 *    every throwable, so the retry predicate reads that classification instead
 *    of sniffing messages here.
 *  · **Focus and connectivity ride on `AppState`.** NetInfo would give a truer
 *    online signal, but it is not in the dependency set and adding a native
 *    module would cost Expo Go compatibility (see `docs/BUILD_CONTRACT.md`).
 *    Backgrounded is therefore treated as offline: fetches pause instead of
 *    firing into a dead socket, mutations queue, and both resume on return —
 *    which is the behaviour we actually wanted from the online manager anyway.
 *  · **The cache is emptied when the account changes.** Two people share a
 *    phone; one of them must never see the other's vet records for the frame
 *    before a refetch lands.
 *
 * This module also owns the single error→toast funnel every mutation calls.
 * Keeping it here (rather than in each domain file) is what guarantees a
 * `PermissionError` always surfaces as the RBAC explanation with a way to ask
 * the owner, and never as a raw message.
 */

import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
  type QueryKey,
} from '@tanstack/react-query';
import React, { useEffect, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { classifyError, logError, toUserMessage, type AppErrorKind } from '@/lib/errors';
import { showDenial } from '@/rbac/DenialSheet';
import { useSession } from '@/stores/session';
import { toast } from '@/ui/Toast';

/* ------------------------------------------------------------- stale times */

/**
 * One scale, applied per domain, so freshness is a decision rather than an
 * accident. Care tasks move with the clock; a breed group's description does
 * not, and refetching it on every mount is spent battery.
 */
export const STALE = {
  /** Anything the wall clock changes underneath us — today's task stream. */
  live: 15_000,
  /** Logs, feed pages, activity: new rows appear while you watch. */
  short: 60_000,
  /** Records, schedules, caregivers: edited deliberately, rarely. */
  medium: 5 * 60_000,
  /** Groups, profiles: effectively reference data. */
  long: 30 * 60_000,
  /** Signed URLs — refreshed just before the hour they're minted for. */
  signedUrl: 45 * 60_000,
} as const;

/** Keep evicted data around long enough that back-navigation is instant. */
const GC_TIME = 30 * 60_000;

/* ----------------------------------------------------------- retry policy */

/**
 * Failures where a second attempt cannot change the answer. Everything else
 * (offline, transport, timeout, 5xx, genuinely unknown) gets two more goes.
 */
const SETTLED: ReadonlySet<AppErrorKind> = new Set<AppErrorKind>([
  'permission',
  'auth',
  'notFound',
  'validation',
  'conflict',
  'rateLimit',
  'storage',
  'cancelled',
  'unsupported',
]);

const MAX_RETRIES = 2;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (SETTLED.has(classifyError(error).kind)) return false;
  return failureCount < MAX_RETRIES;
}

/** Exponential with jitter, so a flaky connection doesn't get a thundering herd. */
function retryDelay(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 15_000);
  return base + Math.random() * 250;
}

/* ------------------------------------------------------------ error toasts */

export type ErrorToastOptions = {
  /** Wired to the toast's action button when the failure is worth retrying. */
  retry?: () => void;
  /** Breadcrumb for the `__DEV__` log — "feeding.log", "community.like". */
  scope?: string;
};

/**
 * The one place a failed mutation becomes words. Permission denials get the
 * RBAC sheet rather than a sentence, because "Not part of your access" without
 * the *why* is how sitters end up texting the owner in confusion.
 */
export function showErrorToast(error: unknown, options: ErrorToastOptions = {}): void {
  const app = classifyError(error);
  if (options.scope) logError(options.scope, error);

  // The user navigated away or hit cancel. Nothing happened; say nothing.
  if (app.kind === 'cancelled') return;

  const message = toUserMessage(app);

  if (app.kind === 'permission') {
    toast.warning(message.title, {
      description: message.body,
      icon: 'lock-closed',
      action: {
        label: 'Why?',
        onPress: () =>
          showDenial(app.reason ?? 'not-granted', {
            capability: app.capability,
            petId: app.petId,
          }),
      },
    });
    return;
  }

  toast.error(message.title, {
    description: message.body,
    action:
      options.retry && message.retryable
        ? { label: message.actionLabel ?? 'Try again', onPress: options.retry }
        : undefined,
  });
}

/* ------------------------------------------------------ optimistic helpers */

/** `[key, data]` pairs captured before an optimistic write, for exact rollback. */
export type CacheSnapshot = readonly (readonly [QueryKey, unknown])[];

/**
 * Snapshot every cached query under the given prefixes. Prefix-wide rather than
 * key-exact because a single optimistic write usually touches several cached
 * variants of the same list (today's logs, this week's logs, the unfiltered one).
 */
export function captureQueries(client: QueryClient, prefixes: readonly QueryKey[]): CacheSnapshot {
  const entries: (readonly [QueryKey, unknown])[] = [];
  for (const prefix of prefixes) {
    entries.push(...client.getQueriesData({ queryKey: prefix }));
  }
  return entries;
}

/** Put a snapshot back, exactly as it was, after a failed optimistic write. */
export function restoreQueries(client: QueryClient, snapshot: CacheSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [key, data] of snapshot) {
    // Updater form: `setQueryData(key, value)` can't take an `unknown` payload.
    client.setQueryData(key, () => data);
  }
}

/** Fire-and-forget invalidation for a bundle of prefixes (`onSettled` bodies). */
export function invalidateAll(client: QueryClient, prefixes: readonly QueryKey[]): void {
  for (const prefix of prefixes) {
    void client.invalidateQueries({ queryKey: prefix });
  }
}

/* ------------------------------------------------------------------ client */

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE.short,
        gcTime: GC_TIME,
        retry: shouldRetry,
        retryDelay,
        refetchOnReconnect: true,
        // Returning to the app after an hour away should show today's truth.
        refetchOnWindowFocus: true,
        refetchOnMount: true,
      },
      mutations: {
        // A write has side effects; replaying it blindly can double-log a dose.
        retry: false,
      },
    },
  });
}

/**
 * Module-level singleton so imperative callers — a notification tap, a deep
 * link resolving an invite — can invalidate without a React context.
 */
export const queryClient: QueryClient = createQueryClient();

/* --------------------------------------------------- app-state integration */

let managersBound = false;

function bindAppStateManagers(): void {
  if (managersBound) return;
  managersBound = true;

  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      handleFocus(state === 'active');
    });
    return () => subscription.remove();
  });

  onlineManager.setEventListener((setOnline) => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      // `inactive` is the app switcher and the notification shade — a blink,
      // not an absence. Only a real background pauses the data layer.
      setOnline(state !== 'background');
    });
    return () => subscription.remove();
  });
}

bindAppStateManagers();

/* ---------------------------------------------------------------- provider */

export function QueryProvider({ children }: { children: ReactNode }) {
  useEffect(
    () =>
      useSession.subscribe((state, previous) => {
        const next = state.user?.id ?? null;
        if (next === (previous.user?.id ?? null)) return;
        // Sign-out or account switch: cancel in-flight work first so a late
        // response can't repopulate the cache we just emptied.
        void queryClient.cancelQueries();
        queryClient.clear();
      }),
    [],
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export default QueryProvider;
