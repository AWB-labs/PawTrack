/**
 * Petal — deep links.
 *
 * Two directions, and they must agree:
 *
 *  · **Out** — the URL we put in an invite message, a QR code or a notification
 *    payload. Built from `Linking.createURL()` so it resolves to the dev server
 *    in Expo Go (`exp://…/--/invite/CODE`) and to the custom scheme in a real
 *    build, without a branch at the call site.
 *  · **In** — an arbitrary URL from the world, narrowed to a typed
 *    `RouteIntent`. expo-router already routes matching paths on its own; the
 *    value here is *understanding* the URL before navigating — so the join
 *    screen can pre-validate a pasted link, and a signed-out tap on an invite
 *    can be remembered rather than dropped.
 *
 * Outbound paths deliberately mirror the file routes under `app/`, so there is
 * one shape to keep in sync rather than a link scheme and a router that drift.
 */

import * as Linking from 'expo-linking';
import type { Href } from 'expo-router';
import { Platform } from 'react-native';

import type { ID } from '@/data/types';
import { normalizeInviteCode, parseInviteCode } from './id';

/* ------------------------------------------------------------- constants */

/** Matches `expo.scheme` in app.json. */
export const PETAL_SCHEME = 'petal';

/**
 * Universal-link host. An invite pasted into a browser, an email preview or a
 * device without Petal installed still lands somewhere that explains itself.
 */
export const PETAL_WEB_ORIGIN = 'https://petal.app';

export const INVITE_SEGMENT = 'invite';

/* ----------------------------------------------------------------- types */

export type PetSection =
  | 'feeding'
  | 'medicine'
  | 'appointments'
  | 'weight'
  | 'vaccinations'
  | 'vet-visits'
  | 'documents'
  | 'caregivers'
  | 'activity'
  | 'edit'
  | 'invite';

export type RecordForm =
  | 'weight'
  | 'vaccination'
  | 'vet-visit'
  | 'feeding-schedule'
  | 'medicine'
  | 'appointment'
  | 'document';

export type SettingsSection = 'appearance' | 'notifications' | 'security' | 'account' | 'about';

export type TabName = 'today' | 'pets' | 'community' | 'you';

export type RouteIntent =
  | { kind: 'invite'; code: string; valid: boolean }
  | { kind: 'pet'; petId: ID; section: PetSection | null }
  | { kind: 'record'; form: RecordForm; petId: ID | null; entityId: ID | null }
  | { kind: 'post'; postId: ID }
  | { kind: 'group'; groupId: ID }
  | { kind: 'tab'; tab: TabName }
  | { kind: 'settings'; section: SettingsSection | null }
  | { kind: 'passwordReset'; token: string | null }
  | { kind: 'unhandled'; url: string };

const PET_SECTIONS = new Set<string>([
  'feeding', 'medicine', 'appointments', 'weight', 'vaccinations',
  'vet-visits', 'documents', 'caregivers', 'activity', 'edit', 'invite',
]);

const RECORD_FORMS = new Set<string>([
  'weight', 'vaccination', 'vet-visit', 'feeding-schedule', 'medicine', 'appointment', 'document',
]);

const SETTINGS_SECTIONS = new Set<string>(['appearance', 'notifications', 'security', 'account', 'about']);

const TABS = new Set<string>(['today', 'pets', 'community', 'you']);

/* --------------------------------------------------------------- building */

/**
 * `petal://invite/BUDDY-4KQ2` in a build, `exp://…/--/invite/BUDDY-4KQ2` in
 * Expo Go. Always pass this to a QR code or a share sheet — never a hand-built
 * `petal://` string, which silently breaks every development client.
 */
export function buildInviteUrl(code: string): string {
  return Linking.createURL(`/${INVITE_SEGMENT}/${encodeURIComponent(normalizeInviteCode(code))}`);
}

/** The shareable https twin, for messages that will be read on a laptop. */
export function buildInviteWebUrl(code: string): string {
  return `${PETAL_WEB_ORIGIN}/${INVITE_SEGMENT}/${encodeURIComponent(normalizeInviteCode(code))}`;
}

export function buildPetUrl(petId: ID, section?: PetSection): string {
  return Linking.createURL(`/pet/${encodeURIComponent(petId)}${section ? `/${section}` : ''}`);
}

export function buildPostUrl(postId: ID): string {
  return Linking.createURL(`/community/post/${encodeURIComponent(postId)}`);
}

/* ---------------------------------------------------------------- parsing */

function firstParam(params: Linking.QueryParams | null, key: string): string | null {
  const value = params?.[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Flatten a URL into path segments regardless of which shape it arrived in.
 *
 * `petal://invite/CODE` parses with `invite` as the *hostname*, while
 * `https://petal.app/invite/CODE` parses it as the first path segment. A
 * hostname with no dot in it is therefore a route segment, not a domain.
 */
function segmentsOf(parsed: Linking.ParsedURL): string[] {
  const segments: string[] = [];
  const host = parsed.hostname;
  if (host && !host.includes('.') && host !== 'localhost') segments.push(host);
  if (parsed.path) segments.push(...parsed.path.split('/'));

  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0 && segment !== '--');
}

/** Narrow any incoming URL to something the app knows how to act on. */
export function parseUrl(url: string): RouteIntent {
  let parsed: Linking.ParsedURL;
  try {
    parsed = Linking.parse(url);
  } catch {
    return { kind: 'unhandled', url };
  }

  const segments = segmentsOf(parsed);
  const params = parsed.queryParams;
  const [head, second, third] = segments;

  if (!head) return { kind: 'tab', tab: 'today' };

  // Invites carry the whole point of the caregiver flow, so accept the friendly
  // `/join/` alias people type from memory as well as the canonical path.
  if (head === INVITE_SEGMENT || head === 'join') {
    const raw = second ?? firstParam(params, 'code') ?? '';
    const check = parseInviteCode(raw);
    return { kind: 'invite', code: normalizeInviteCode(raw), valid: check.valid };
  }

  if (head === 'pet' && second) {
    const section = third && PET_SECTIONS.has(third) ? (third as PetSection) : null;
    return { kind: 'pet', petId: second, section };
  }

  if (head === 'record' && second && RECORD_FORMS.has(second)) {
    return {
      kind: 'record',
      form: second as RecordForm,
      petId: firstParam(params, 'petId'),
      entityId: firstParam(params, 'id'),
    };
  }

  if (head === 'community' && second === 'post' && third) return { kind: 'post', postId: third };
  if (head === 'community' && second === 'group' && third) return { kind: 'group', groupId: third };
  if (head === 'post' && second) return { kind: 'post', postId: second };
  if (head === 'group' && second) return { kind: 'group', groupId: second };

  if (head === 'settings') {
    const section = second && SETTINGS_SECTIONS.has(second) ? (second as SettingsSection) : null;
    return { kind: 'settings', section };
  }

  if (head === 'reset-password' || (head === 'auth' && second === 'reset')) {
    return {
      kind: 'passwordReset',
      token: firstParam(params, 'token') ?? firstParam(params, 'access_token'),
    };
  }

  if (TABS.has(head)) return { kind: 'tab', tab: head as TabName };

  return { kind: 'unhandled', url };
}

/** Whether a URL is ours at all — used to ignore links we were handed by accident. */
export function isPetalUrl(url: string): boolean {
  try {
    const parsed = Linking.parse(url);
    if (parsed.scheme === PETAL_SCHEME) return true;
    if (parsed.hostname && PETAL_WEB_ORIGIN.endsWith(parsed.hostname)) return true;
    // Expo Go and dev clients serve the app over exp:// and http://<lan-ip>.
    return parsed.scheme === 'exp' || parsed.scheme === 'exps';
  } catch {
    return false;
  }
}

/** The URL that cold-started the app, if any. */
export async function getInitialIntent(): Promise<RouteIntent | null> {
  const url = await Linking.getInitialURL();
  return url ? parseUrl(url) : null;
}

/** Links that arrive while the app is already running. Returns an unsubscribe. */
export function addIntentListener(listener: (intent: RouteIntent) => void): () => void {
  const subscription = Linking.addEventListener('url', ({ url }) => listener(parseUrl(url)));
  return () => subscription.remove();
}

/* ---------------------------------------------------------------- routing */

/** The in-app path for an intent. Mirrors the file routes under `app/`. */
export function hrefFor(intent: RouteIntent): string {
  switch (intent.kind) {
    case 'invite':
      return `/${INVITE_SEGMENT}/${intent.code}`;
    case 'pet':
      return `/pet/${intent.petId}${intent.section ? `/${intent.section}` : ''}`;
    case 'record': {
      const query = [
        intent.petId ? `petId=${encodeURIComponent(intent.petId)}` : null,
        intent.entityId ? `id=${encodeURIComponent(intent.entityId)}` : null,
      ].filter(Boolean);
      return `/record/${intent.form}${query.length > 0 ? `?${query.join('&')}` : ''}`;
    }
    case 'post':
      return `/community/post/${intent.postId}`;
    case 'group':
      return `/community/group/${intent.groupId}`;
    case 'tab':
      return intent.tab === 'today' ? '/' : `/${intent.tab}`;
    case 'settings':
      return intent.section ? `/settings/${intent.section}` : '/settings';
    case 'passwordReset':
      return '/forgot-password';
    default:
      return '/';
  }
}

/**
 * `typedRoutes` narrows `Href` to the generated union of literal routes, which
 * cannot describe a path assembled at runtime. The assertion is confined to
 * this one function so every call site above stays plain, checkable strings.
 */
export function toHref(path: string): Href {
  return path as Href;
}

/* -------------------------------------------------------------- outbound */

/**
 * Open a link outside the app. Returns `false` instead of throwing when
 * nothing can handle it — a clinic row with a malformed phone number should
 * stay inert, not crash the screen.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

export function callPhone(rawNumber: string): Promise<boolean> {
  const number = rawNumber.replace(/[^\d+]/g, '');
  if (!number) return Promise.resolve(false);
  // `telprompt:` lets iOS confirm before dialling; Android only knows `tel:`.
  return openExternal(`${Platform.OS === 'ios' ? 'telprompt' : 'tel'}:${number}`);
}

export function composeEmail(address: string, subject?: string): Promise<boolean> {
  const query = subject ? `?subject=${encodeURIComponent(subject)}` : '';
  return openExternal(`mailto:${address}${query}`);
}

/** Open a clinic's address in whichever maps app the platform prefers. */
export function openMaps(address: string, label?: string): Promise<boolean> {
  const query = encodeURIComponent(address);
  if (Platform.OS === 'ios') {
    return openExternal(`maps://?q=${encodeURIComponent(label ?? address)}&address=${query}`);
  }
  return openExternal(`geo:0,0?q=${query}${label ? `(${encodeURIComponent(label)})` : ''}`);
}

/** Jump straight to Petal's page in the OS settings app. */
export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}

export const deeplinks = {
  PETAL_SCHEME,
  PETAL_WEB_ORIGIN,
  buildInviteUrl,
  buildInviteWebUrl,
  buildPetUrl,
  buildPostUrl,
  parseUrl,
  isPetalUrl,
  getInitialIntent,
  addIntentListener,
  hrefFor,
  toHref,
  openExternal,
  callPhone,
  composeEmail,
  openMaps,
  openAppSettings,
};

export default deeplinks;
