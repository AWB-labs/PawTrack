/**
 * Petal — adapter selection.
 *
 * The whole two-backend story collapses into this file: it decides *once*, at
 * import time, whether the app talks to Supabase or to the seeded offline mock,
 * and exports a single `adapter` that nothing above it can distinguish.
 *
 * Two rules it must never break:
 *
 *  1. **Importing this module cannot throw.** A reviewer running `npx expo start`
 *     with no `.env` is the common case, not the edge case. `isSupabaseConfigured()`
 *     is a pure string check (no network, no client construction), and even a
 *     configured-but-broken project degrades to the demo rather than to a blank
 *     screen with a red box.
 *  2. **The choice is made once.** Swapping adapters mid-session would leave
 *     React Query holding rows from one world and mutations landing in another,
 *     so there is no setter here. Adding credentials and restarting is the
 *     entire migration path.
 */

import type { DataAdapter } from './adapter';
import { MockAdapter } from './mock/MockAdapter';
import { SupabaseAdapter } from './SupabaseAdapter';
import { isSupabaseConfigured, supabaseHost } from './supabase';

/* -------------------------------------------------------------------- types */

export type DataMode = DataAdapter['kind'];

export type DataSourceInfo = {
  mode: DataMode;
  /** Host of the live project, or null on demo data. */
  host: string | null;
  /** Short label for a settings row — "Demo data" / "Live · xyz.supabase.co". */
  label: string;
  /** One sentence a non-engineer can read. */
  detail: string;
  /**
   * Set when credentials were present but the client refused to build. Surfaced
   * in developer settings so a typo'd URL isn't silently swallowed.
   */
  fallbackReason: string | null;
  /** True when `resetDemoData()` is a real operation rather than a thrower. */
  canResetDemoData: boolean;
};

/* ---------------------------------------------------------------- selection */

let fallbackReason: string | null = null;

function selectAdapter(): DataAdapter {
  if (!isSupabaseConfigured()) return new MockAdapter();

  try {
    return new SupabaseAdapter();
  } catch (error) {
    // A malformed URL or a truncated anon key must cost the user the *live*
    // backend, not the app. They still get a fully working demo household.
    fallbackReason = error instanceof Error ? error.message : String(error);
    return new MockAdapter();
  }
}

/** The one instance. Screens reach it through `@/data/queries/*`, never directly. */
export const adapter: DataAdapter = selectAdapter();

export const dataMode: DataMode = adapter.kind;

export const isMockData: boolean = dataMode === 'mock';

/**
 * Typed handle on the mock, for the developer settings screen (reseed, failure
 * injection). Null whenever the live backend is active, which is exactly the
 * condition those controls should hide on.
 */
export const mockAdapter: MockAdapter | null = adapter instanceof MockAdapter ? adapter : null;

/* --------------------------------------------------------------------- dev */

/** Everything the "Data source" row in developer settings needs, in one call. */
export function describeDataSource(): DataSourceInfo {
  const host = supabaseHost();

  if (dataMode === 'supabase') {
    return {
      mode: 'supabase',
      host,
      label: host ? `Live · ${host}` : 'Live',
      detail:
        'Furry Tracker is talking to your Supabase project. Changes sync to everyone who shares a pet with you.',
      fallbackReason: null,
      canResetDemoData: false,
    };
  }

  return {
    mode: 'mock',
    host: null,
    label: 'Demo data',
    detail: fallbackReason
      ? 'Your Supabase details didn’t load, so Furry Tracker fell back to the demo household. Everything you change stays on this device.'
      : 'Furry Tracker is running the offline demo household. Everything you change stays on this device.',
    fallbackReason,
    canResetDemoData: typeof adapter.resetDemoData === 'function',
  };
}

if (__DEV__) {
  const info = describeDataSource();
  // One line at boot beats hunting for which backend answered a failing call.
  console.info(`[petal:data] ${info.label} — ${info.detail}`);
  if (info.fallbackReason) console.warn(`[petal:data] Supabase unavailable — ${info.fallbackReason}`);
}
