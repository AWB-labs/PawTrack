/**
 * Petal — error translation.
 *
 * One job: nothing a server, a driver or a stray `throw` says ever reaches a
 * person. `classifyError()` narrows an unknown throwable into a small typed
 * union, and `toUserMessage()` turns that union into copy that says what
 * happened and what to do next.
 *
 * Why bother, rather than `catch (e) { toast(e.message) }`:
 *
 *  · Raw messages are written for engineers. "duplicate key value violates
 *    unique constraint" is a sentence about Postgres, not about the person
 *    trying to add their cat twice.
 *  · They leak. Column names, table names and RLS policy names in a toast are
 *    a free schema tour for anyone who wants one.
 *  · They're unactionable. Every message here ends with the next move, and the
 *    `action` field tells the UI which button to render.
 *
 * The original is never thrown away — it lands in `debug`, which is surfaced
 * only under `__DEV__`.
 */

import {
  CAPABILITY_LABELS,
  DENIAL_COPY,
  PermissionError,
  type Capability,
  type DenialReason,
} from '@/rbac/permissions';

/* ------------------------------------------------------------------ types */

export type AuthErrorCode =
  | 'invalid-credentials'
  | 'email-taken'
  | 'email-not-confirmed'
  | 'weak-password'
  | 'invalid-email'
  | 'session-expired'
  | 'signup-disabled'
  | 'unknown';

export type AppError =
  | { kind: 'permission'; capability: Capability | null; petId: string | null; reason: DenialReason | null; debug: string }
  | { kind: 'offline'; debug: string }
  | { kind: 'network'; debug: string }
  | { kind: 'timeout'; debug: string }
  | { kind: 'auth'; code: AuthErrorCode; debug: string }
  | { kind: 'notFound'; entity: string | null; debug: string }
  | { kind: 'conflict'; debug: string }
  | { kind: 'validation'; field: string | null; detail: string | null; debug: string }
  | { kind: 'rateLimit'; retryAfterSeconds: number | null; debug: string }
  | { kind: 'storage'; debug: string }
  | { kind: 'cancelled'; debug: string }
  | { kind: 'unsupported'; debug: string }
  | { kind: 'unknown'; debug: string };

export type AppErrorKind = AppError['kind'];

/** Which affordance the error screen or toast should offer. */
export type ErrorAction = 'retry' | 'signIn' | 'openSettings' | 'askOwner' | 'goBack' | 'none';

export type UserMessage = {
  title: string;
  /** One or two sentences. Says what happened, then what to do. */
  body: string;
  action: ErrorAction;
  /** Label for the action button. Null when `action` is `'none'`. */
  actionLabel: string | null;
  retryable: boolean;
  /** Drives the illustration + colour token on error states. */
  tone: 'info' | 'warning' | 'danger';
};

/**
 * Our own throwable, for failures that originate in the app rather than in a
 * driver — a share sheet that isn't available, a file we can't read.
 */
export class PetalError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = 'PetalError';
    this.kind = kind;
  }
}

/* ------------------------------------------------------------- structural */

/**
 * Duck-typed rather than imported from `@supabase/supabase-js`, so this module
 * stays usable with the mock adapter and adds nothing to the bundle graph.
 */
type PostgrestLike = { code: string; message: string; details?: string | null; hint?: string | null };
type AuthLike = { name: string; status?: number; code?: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPostgrestLike(value: unknown): value is PostgrestLike {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string' && 'details' in value;
}

function isAuthLike(value: unknown): value is AuthLike {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    /Auth(Api|Retryable|Session|Weak|Unknown|Invalid)?/.test(value.name) &&
    typeof value.message === 'string'
  );
}

/**
 * `DataError` (and its subclasses — `NetworkError`, `AuthenticationError`,
 * `NotFoundError`, …) live in `SupabaseAdapter.ts`, not here, so this module
 * doesn't take on that file as a dependency — same reasoning as the
 * `PostgrestLike`/`AuthLike` duck-types above. A subclass overrides `.name`
 * (`'NetworkError'`, not `'DataError'`), so the only reliable tell is `.kind`
 * holding one of the adapter's own kind strings.
 */
type DataErrorLike = { kind: string; message: string; detail?: string | null };

const DATA_ERROR_KINDS = new Set([
  'network',
  'auth',
  'permission',
  'not-found',
  'conflict',
  'invalid',
  'storage',
  'cancelled',
  'server',
]);

function isDataErrorLike(value: unknown): value is DataErrorLike {
  return (
    value instanceof Error &&
    isRecord(value) &&
    typeof value.kind === 'string' &&
    DATA_ERROR_KINDS.has(value.kind)
  );
}

/**
 * `SupabaseAdapter.ts` already did the real classification — a raw Postgres
 * code or GoTrue message turned into one of `DataErrorKind`'s buckets, with a
 * message already safe to show. This maps that decision onto `AppErrorKind`
 * instead of re-deriving it from scratch, which is what let a `DataError`
 * fall through every check below to the generic `'unknown'` bucket: it isn't
 * a `PermissionError`, isn't `PostgrestLike` (the adapter already unwrapped
 * that shape away), and carries no HTTP `status` for the later checks to key
 * on. The user saw "Something went sideways" instead of "You don't have
 * access to do that" purely because this mapping didn't exist yet.
 */
function fromDataError(error: DataErrorLike, debug: string): AppError {
  switch (error.kind) {
    case 'network':
      return { kind: 'network', debug };
    case 'storage':
      return { kind: 'storage', debug };
    case 'cancelled':
      return { kind: 'cancelled', debug };
    case 'conflict':
      return { kind: 'conflict', debug };
    case 'not-found':
      return { kind: 'notFound', entity: null, debug };
    case 'invalid':
      return { kind: 'validation', field: null, detail: error.detail ?? null, debug };
    case 'permission':
      return { kind: 'permission', capability: null, petId: null, reason: null, debug };
    case 'auth':
      return { kind: 'auth', code: matchAuthMessage(error.message), debug };
    // 'server': the adapter's retryable "something went wrong on our side"
    // fallback has no matching AppErrorKind of its own; 'unknown' renders the
    // same "try again" affordance without inventing a new bucket for one case.
    case 'server':
    default:
      return { kind: 'unknown', debug };
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* -------------------------------------------------------- postgres codes */

/**
 * The handful of SQLSTATEs a client actually sees. Anything else falls through
 * to `unknown`, which is honest — inventing copy for `42P01` would only teach
 * the user that Petal is broken in a way they can fix.
 */
const POSTGRES: Record<string, ((e: PostgrestLike) => AppError) | undefined> = {
  // unique_violation — "you already have a Buddy"
  '23505': (e) => ({ kind: 'conflict', debug: describe(e) }),
  // foreign_key_violation — the thing it points at vanished mid-edit
  '23503': (e) => ({ kind: 'conflict', debug: describe(e) }),
  // not_null_violation / check_violation / invalid text — a field is wrong
  '23502': (e) => ({ kind: 'validation', field: columnFrom(e), detail: null, debug: describe(e) }),
  '23514': (e) => ({ kind: 'validation', field: columnFrom(e), detail: null, debug: describe(e) }),
  '22P02': (e) => ({ kind: 'validation', field: null, detail: null, debug: describe(e) }),
  '22001': (e) => ({ kind: 'validation', field: columnFrom(e), detail: 'too long', debug: describe(e) }),
  // insufficient_privilege — RLS said no. The client-side check should have
  // caught this first; if we're here, treat it as a real denial.
  '42501': (e) => ({ kind: 'permission', capability: null, petId: null, reason: null, debug: describe(e) }),
  // serialization_failure / deadlock — genuinely worth retrying
  '40001': (e) => ({ kind: 'conflict', debug: describe(e) }),
  '40P01': (e) => ({ kind: 'conflict', debug: describe(e) }),
  // statement_timeout / query_canceled
  '57014': (e) => ({ kind: 'timeout', debug: describe(e) }),
  '53300': (e) => ({ kind: 'network', debug: describe(e) }),
  // PostgREST: no rows from `.single()`
  PGRST116: (e) => ({ kind: 'notFound', entity: null, debug: describe(e) }),
  // PostgREST: JWT expired / invalid
  PGRST301: (e) => ({ kind: 'auth', code: 'session-expired', debug: describe(e) }),
  PGRST302: (e) => ({ kind: 'auth', code: 'session-expired', debug: describe(e) }),
};

/** Postgres puts the offending column in `details`; pull it out for the copy. */
function columnFrom(error: PostgrestLike): string | null {
  const match = /column "([^"]+)"|Key \(([^)]+)\)/.exec(`${error.message} ${error.details ?? ''}`);
  return match?.[1] ?? match?.[2] ?? null;
}

const AUTH_CODES: Record<string, AuthErrorCode | undefined> = {
  invalid_credentials: 'invalid-credentials',
  invalid_grant: 'invalid-credentials',
  email_not_confirmed: 'email-not-confirmed',
  user_already_exists: 'email-taken',
  email_exists: 'email-taken',
  weak_password: 'weak-password',
  email_address_invalid: 'invalid-email',
  validation_failed: 'invalid-email',
  session_not_found: 'session-expired',
  refresh_token_not_found: 'session-expired',
  session_expired: 'session-expired',
  signup_disabled: 'signup-disabled',
};

/* -------------------------------------------------------------- classify */

export function classifyError(error: unknown): AppError {
  const debug = describe(error);

  if (error instanceof PermissionError) {
    return {
      kind: 'permission',
      capability: error.capability,
      petId: error.petId,
      reason: error.reason,
      debug,
    };
  }

  if (error instanceof PetalError) {
    return withKind(error.kind, debug);
  }

  // Checked ahead of the PostgrestLike/AuthLike/status-code branches below:
  // by the time SupabaseAdapter.ts throws a DataError, it has already
  // unwrapped the raw Postgres/GoTrue error away, so none of those shape
  // checks would ever match it — every DataError silently became 'unknown'.
  if (isDataErrorLike(error)) {
    return fromDataError(error, debug);
  }

  // Aborted requests (React Query cancellation, user navigating away) are not
  // failures and must never surface as one.
  if (isRecord(error) && (error.name === 'AbortError' || error.name === 'CanceledError')) {
    return { kind: 'cancelled', debug };
  }

  if (isPostgrestLike(error)) {
    const handler = POSTGRES[error.code];
    if (handler) return handler(error);
    if (/permission denied|row-level security/i.test(error.message)) {
      return { kind: 'permission', capability: null, petId: null, reason: null, debug };
    }
    return { kind: 'unknown', debug };
  }

  const status = statusFrom(error);

  if (isAuthLike(error)) {
    if (status === 429) return { kind: 'rateLimit', retryAfterSeconds: null, debug };
    const code = error.code ? AUTH_CODES[error.code] : undefined;
    if (code) return { kind: 'auth', code, debug };
    if (status === 401 || status === 403) return { kind: 'auth', code: 'session-expired', debug };
    return { kind: 'auth', code: matchAuthMessage(error.message), debug };
  }

  if (status !== null) {
    if (status === 401) return { kind: 'auth', code: 'session-expired', debug };
    if (status === 403) return { kind: 'permission', capability: null, petId: null, reason: null, debug };
    if (status === 404) return { kind: 'notFound', entity: null, debug };
    if (status === 409) return { kind: 'conflict', debug };
    if (status === 413) return { kind: 'storage', debug };
    if (status === 422) return { kind: 'validation', field: null, detail: null, debug };
    if (status === 429) return { kind: 'rateLimit', retryAfterSeconds: retryAfterFrom(error), debug };
    if (status >= 500) return { kind: 'network', debug };
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  // React Native's fetch reports every transport failure as this exact string.
  if (/Network request failed|Failed to fetch|ERR_INTERNET_DISCONNECTED/i.test(message)) {
    return { kind: 'offline', debug };
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return { kind: 'timeout', debug };
  if (/aborted|cancell?ed/i.test(message)) return { kind: 'cancelled', debug };
  if (/bucket not found|payload too large|exceeded the maximum|storage/i.test(message)) {
    return { kind: 'storage', debug };
  }
  if (/not (available|supported)|unimplemented/i.test(message)) return { kind: 'unsupported', debug };

  return { kind: 'unknown', debug };
}

function matchAuthMessage(message: string): AuthErrorCode {
  if (/invalid login|invalid credentials|incorrect/i.test(message)) return 'invalid-credentials';
  if (/already registered|already exists/i.test(message)) return 'email-taken';
  if (/confirm/i.test(message)) return 'email-not-confirmed';
  if (/password/i.test(message)) return 'weak-password';
  if (/email/i.test(message)) return 'invalid-email';
  return 'unknown';
}

function statusFrom(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const raw = error.status;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function retryAfterFrom(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const raw = error.retryAfter ?? error.retry_after;
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(value) ? value : null;
}

/** Rehydrate a `PetalError`'s kind into the full union, filling the extras. */
function withKind(kind: AppErrorKind, debug: string): AppError {
  switch (kind) {
    case 'permission':
      return { kind, capability: null, petId: null, reason: null, debug };
    case 'auth':
      return { kind, code: 'unknown', debug };
    case 'notFound':
      return { kind, entity: null, debug };
    case 'validation':
      return { kind, field: null, detail: null, debug };
    case 'rateLimit':
      return { kind, retryAfterSeconds: null, debug };
    case 'offline':
    case 'network':
    case 'timeout':
    case 'conflict':
    case 'storage':
    case 'cancelled':
    case 'unsupported':
      return { kind, debug };
    default:
      return { kind: 'unknown', debug };
  }
}

/* --------------------------------------------------------------- copy */

const GENERIC_DENIAL = {
  title: 'You can’t do that here',
  body: 'The owner keeps this one to themselves. Ask them if you need it and they can turn it on.',
};

/**
 * The single function the UI calls. Accepts a raw throwable *or* an already
 * classified error, so a catch block never has to remember which it has.
 */
export function toUserMessage(error: unknown): UserMessage {
  const app = isAppError(error) ? error : classifyError(error);

  switch (app.kind) {
    case 'permission': {
      const copy = app.reason ? DENIAL_COPY[app.reason] : GENERIC_DENIAL;
      const what = app.capability ? CAPABILITY_LABELS[app.capability] : null;
      return {
        title: copy.title,
        body: what ? `${copy.body} (${what})` : copy.body,
        action: 'askOwner',
        actionLabel: 'Ask the owner',
        retryable: false,
        tone: 'warning',
      };
    }

    case 'offline':
      return {
        title: 'You’re offline',
        body: 'Furry Tracker can’t reach the network right now. Nothing was lost — reconnect and try again.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'info',
      };

    case 'network':
      return {
        title: 'Couldn’t reach Furry Tracker',
        body: 'The connection dropped somewhere along the way. One more go usually does it.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'warning',
      };

    case 'timeout':
      return {
        title: 'That’s taking a while',
        body: 'The server didn’t answer in time. Give it a moment and try again.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'warning',
      };

    case 'auth':
      return authMessage(app.code);

    case 'notFound':
      return {
        title: app.entity ? `That ${app.entity} isn’t here any more` : 'That’s not here any more',
        body: 'It may have been deleted, or another caregiver moved it. Head back and we’ll refresh the list.',
        action: 'goBack',
        actionLabel: 'Go back',
        retryable: false,
        tone: 'info',
      };

    case 'conflict':
      return {
        title: 'Something changed underneath you',
        body: 'Either this already exists, or someone else edited it a second ago. Take a look and try again.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'warning',
      };

    case 'validation':
      return {
        title: 'That won’t save yet',
        body: app.field
          ? `The ${humanField(app.field)} field needs another look${app.detail ? ` — it’s ${app.detail}` : ''}.`
          : 'One of the fields isn’t quite right. Check the highlighted ones and try again.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'warning',
      };

    case 'rateLimit':
      return {
        title: 'One moment',
        body: app.retryAfterSeconds
          ? `That’s a lot of tries in a row. Have another go in ${Math.ceil(app.retryAfterSeconds)} seconds.`
          : 'That’s a lot of tries in a row. Wait about half a minute and go again.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'warning',
      };

    case 'storage':
      return {
        title: 'That file wouldn’t upload',
        body: 'It might be too large or in a format we can’t read. A photo or a PDF under 25 MB works best.',
        action: 'retry',
        actionLabel: 'Pick another file',
        retryable: true,
        tone: 'warning',
      };

    case 'cancelled':
      return {
        title: 'Cancelled',
        body: 'No changes were made.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'info',
      };

    case 'unsupported':
      return {
        title: 'Not available on this device',
        body: 'Your phone doesn’t support that one. Everything else in Furry Tracker works as normal.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'info',
      };

    default:
      return {
        title: 'Something went sideways',
        body: 'That didn’t go through, and we’re not sure why. Try again — if it keeps happening, tell us from Settings › About.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'danger',
      };
  }
}

function authMessage(code: AuthErrorCode): UserMessage {
  switch (code) {
    case 'invalid-credentials':
      return {
        title: 'That didn’t match',
        body: 'Check the email and password and try once more. Forgotten it? We can send a reset link.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'warning',
      };
    case 'email-taken':
      return {
        title: 'That email is already with us',
        body: 'Sign in instead — or reset the password if it’s slipped your mind.',
        action: 'signIn',
        actionLabel: 'Sign in',
        retryable: false,
        tone: 'info',
      };
    case 'email-not-confirmed':
      return {
        title: 'Confirm your email first',
        body: 'We sent a link when you signed up. Tap it, then come back and sign in.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'info',
      };
    case 'weak-password':
      return {
        title: 'That password is a little thin',
        body: 'Eight characters or more, with at least one number or symbol, and it’s good to go.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'warning',
      };
    case 'invalid-email':
      return {
        title: 'That email looks off',
        body: 'Check for a typo — a missing @ or an extra dot is usually the culprit.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'warning',
      };
    case 'session-expired':
      return {
        title: 'You’ve been signed out',
        body: 'Furry Tracker signs you out after a long gap to keep your pets’ records private. Sign back in to carry on.',
        action: 'signIn',
        actionLabel: 'Sign in',
        retryable: false,
        tone: 'info',
      };
    case 'signup-disabled':
      return {
        title: 'New accounts are paused',
        body: 'We’re not taking sign-ups at the moment. If you were invited to help with a pet, ask for the link again shortly.',
        action: 'none',
        actionLabel: null,
        retryable: false,
        tone: 'info',
      };
    default:
      return {
        title: 'Couldn’t sign you in',
        body: 'Something went wrong on the way. Try again in a moment.',
        action: 'retry',
        actionLabel: 'Try again',
        retryable: true,
        tone: 'danger',
      };
  }
}

function humanField(field: string): string {
  return field.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/* ------------------------------------------------------------- helpers */

export function isAppError(value: unknown): value is AppError {
  return isRecord(value) && typeof value.kind === 'string' && typeof value.debug === 'string';
}

export function isPermissionDenied(error: unknown): boolean {
  return classifyError(error).kind === 'permission';
}

/** True when a retry has a real chance of a different outcome. */
export function isRetryable(error: unknown): boolean {
  return toUserMessage(error).retryable;
}

/** Single line for a toast, where a title + body block is too much furniture. */
export function toToastMessage(error: unknown): string {
  const { title, body } = toUserMessage(error);
  return `${title.replace(/[.!?]$/, '')} — ${firstSentence(body)}`;
}

/** Hermes' regex engine has no lookbehind, so we find the break by hand. */
function firstSentence(text: string): string {
  const match = /[.!?](\s|$)/.exec(text);
  return match ? text.slice(0, match.index + 1) : text;
}

/**
 * Development-only breadcrumb. Production users get `toUserMessage`; we get the
 * original throwable with the call site attached.
 */
export function logError(scope: string, error: unknown): void {
  if (__DEV__) {
    const app = classifyError(error);
    console.warn(`[petal:${scope}] ${app.kind} — ${app.debug}`);
  }
}
