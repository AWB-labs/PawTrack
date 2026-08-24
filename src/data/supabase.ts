/**
 * Petal — Supabase client.
 *
 * The app ships fully explorable on the mock adapter, so this module has one
 * hard requirement: **importing it must never throw**. Credentials arrive later
 * (or never, for a reviewer running the demo), and a module-level `throw` here
 * would take the whole bundle down before a single screen renders. So the client
 * is built lazily and `isSupabaseConfigured()` is the only thing `data/index.ts`
 * needs to consult when choosing an adapter.
 *
 * Three React-Native specifics that are easy to get wrong:
 *
 *  1. **`react-native-url-polyfill/auto` must be imported first.** Hermes ships
 *     an incomplete `URL`, and both PostgREST and the auth PKCE flow build URLs
 *     with `searchParams`. Without the polyfill you get silent 400s.
 *  2. **`detectSessionInUrl: false`.** That flag exists for browsers reading the
 *     OAuth fragment off `window.location`. On native there is no location bar;
 *     we hand the redirect URL to the auth client ourselves.
 *  3. **Auto-refresh must follow the app lifecycle.** Supabase's refresh timer is
 *     a JS interval — while the app is backgrounded it either doesn't fire or
 *     fires late against a dead socket, and the user comes back to a 401. The
 *     documented fix is to stop the timer on background and start it on
 *     foreground, which is what `bindAutoRefreshToAppState` does.
 */

import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

/* ---------------------------------------------------------------- constants */

/** Storage bucket holding every pet photo, document scan and x-ray. */
export const MEDIA_BUCKET = 'pet-media';

/** Signed-URL lifetime. Long enough to open a PDF, short enough to be useless if leaked. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Namespaced so a second Supabase-backed app on the same device (or a future
 * Petal staging build) can't clobber the session.
 */
export const AUTH_STORAGE_KEY = 'petal.auth.v1';

/** Deep-link path the OAuth provider returns to. Pairs with `scheme: "petal"`. */
export const OAUTH_REDIRECT_PATH = 'auth/callback';

/* --------------------------------------------------------------------- env */

/**
 * `EXPO_PUBLIC_*` values are inlined by Metro at build time, so these are plain
 * string literals in the bundle — read once, trimmed, and never re-read.
 */
const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

/** Anon keys are JWTs (or the newer `sb_publishable_…`); both are comfortably long. */
const MIN_KEY_LENGTH = 20;

const isHttpUrl = (value: string): boolean => /^https?:\/\/[^\s/]+/i.test(value);

/**
 * The single switch between the mock and the live backend. Deliberately does no
 * network work — it answers instantly at startup so the splash screen doesn't
 * wait on a probe.
 */
export function isSupabaseConfigured(): boolean {
  return isHttpUrl(SUPABASE_URL) && SUPABASE_ANON_KEY.length >= MIN_KEY_LENGTH;
}

/** Host only, for the "connected to …" line in developer settings. */
export function supabaseHost(): string | null {
  if (!isHttpUrl(SUPABASE_URL)) return null;
  try {
    return new URL(SUPABASE_URL).host;
  } catch {
    return null;
  }
}

/** Thrown only when something asks for the client while the app is in mock mode. */
export class SupabaseConfigError extends Error {
  constructor() {
    super(
      'Furry Tracker is running on demo data. Add EXPO_PUBLIC_SUPABASE_URL and ' +
        'EXPO_PUBLIC_SUPABASE_ANON_KEY to .env and restart to connect the live backend.',
    );
    this.name = 'SupabaseConfigError';
  }
}

/* ------------------------------------------------------------------ client */

let client: SupabaseClient | null = null;
let appStateSubscription: NativeEventSubscription | null = null;

/**
 * Refresh only while the app is foregrounded. `stopAutoRefresh` also cancels an
 * in-flight refresh, so a backgrounded app can't leave a half-written token in
 * AsyncStorage.
 */
function bindAutoRefreshToAppState(sb: SupabaseClient): void {
  if (appStateSubscription) return;

  const sync = (state: AppStateStatus) => {
    if (state === 'active') {
      void sb.auth.startAutoRefresh();
    } else {
      void sb.auth.stopAutoRefresh();
    }
  };

  appStateSubscription = AppState.addEventListener('change', sync);

  // `currentState` is 'unknown' on Android for the first few ms after launch;
  // anything that isn't an explicit background means we're on screen.
  if (AppState.currentState !== 'background') {
    void sb.auth.startAutoRefresh();
  }
}

/**
 * Lazily built singleton. Every call after the first returns the same instance,
 * so realtime sockets and the auth token cache aren't duplicated.
 *
 * @throws {SupabaseConfigError} when the env vars are missing — call
 * `isSupabaseConfigured()` first.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!isSupabaseConfigured()) throw new SupabaseConfigError();

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: AsyncStorage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      // No `window.location` on native — we feed redirects in by hand.
      detectSessionInUrl: false,
      // PKCE keeps the token exchange off the redirect URL, which on a phone is
      // observable by any app registering the same scheme.
      flowType: 'pkce',
    },
    global: {
      headers: { 'X-Client-Info': 'petal-mobile' },
    },
    db: { schema: 'public' },
    realtime: {
      // Care logging is low-frequency; the default 10/s just burns battery.
      params: { eventsPerSecond: 2 },
    },
  });

  bindAutoRefreshToAppState(client);
  return client;
}

/** Null instead of throwing, for optional/diagnostic paths. */
export function getSupabaseOrNull(): SupabaseClient | null {
  return isSupabaseConfigured() ? getSupabase() : null;
}

/**
 * Tears the singleton down. Only used when signing out of a whole environment
 * (or from a dev tool that swaps projects) — normal sign-out keeps the client.
 */
export function disposeSupabase(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  client = null;
}
