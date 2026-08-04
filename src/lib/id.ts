/**
 * Petal — identifiers.
 *
 * Two very different jobs, deliberately in one file so the distinction stays
 * visible:
 *
 *  · **Machine ids** — UUIDv4 from `expo-crypto`. Generated client-side so an
 *    optimistic mutation can render its row before the server has ever heard
 *    of it, and still reconcile cleanly when the insert lands.
 *
 *  · **Invite codes** — read aloud over the phone, typed with one thumb, and
 *    often photographed off someone else's screen. That changes the design
 *    completely: `BUDDY-4KQ2`, where the prefix is the pet (so the reader knows
 *    they got the right code before they type a character) and the suffix comes
 *    from an alphabet with no `0`, `O`, `I` or `1` in it at all.
 *
 * The two halves normalise differently, which is the point. The prefix is
 * letters-only, so a `0` there can only ever have been a misread `O` and we fold
 * it back. The suffix contains neither glyph of any ambiguous pair, so a `0`
 * there is a genuine typo and must fail loudly rather than be guessed at.
 */

import * as Crypto from 'expo-crypto';

import type { ID } from '@/data/types';

/** 32 symbols: A–Z minus I and O, plus 2–9. Divides 256 exactly, so `byte & 31` is unbiased. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const INVITE_SUFFIX_LENGTH = 4;
export const INVITE_PREFIX_MAX = 8;

const FALLBACK_PREFIX = 'PETAL';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Digit → letter, for the letters-only prefix. Never applied to the suffix. */
const PREFIX_FOLD: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B' };

/* ------------------------------------------------------------ machine ids */

export function newId(): ID {
  return Crypto.randomUUID();
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/**
 * Cryptographically random string from the unambiguous alphabet. Used for
 * invite suffixes and anywhere a short opaque token is nicer than a UUID.
 */
export function randomCode(length: number): string {
  const size = Math.max(1, Math.trunc(length));
  const bytes = Crypto.getRandomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    // 256 / 32 is exact, so masking introduces no modulo bias.
    out += CODE_ALPHABET.charAt((bytes[i] ?? 0) & 31);
  }
  return out;
}

/** Short opaque id for things that never need to be globally unique (draft keys, anchors). */
export function shortId(length = 10): string {
  return randomCode(length).toLowerCase();
}

/* --------------------------------------------------------- invite codes */

/**
 * The human-recognisable half. Letters only — digits in a pet's name would
 * reintroduce exactly the ambiguity the suffix alphabet exists to remove.
 */
export function invitePrefix(petName: string): string {
  const letters = deaccent(petName)
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return letters.length >= 2 ? letters.slice(0, INVITE_PREFIX_MAX) : FALLBACK_PREFIX;
}

/** "Bruño" → "Bruno", so the prefix stays typeable on any keyboard. */
function deaccent(value: string): string {
  if (typeof value.normalize !== 'function') return value;
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** `generateInviteCode('Buddy')` → `"BUDDY-4KQ2"`. */
export function generateInviteCode(petName: string, suffixLength = INVITE_SUFFIX_LENGTH): string {
  return `${invitePrefix(petName)}-${randomCode(suffixLength)}`;
}

/**
 * Canonical form for lookup. Tolerant of everything a person plausibly does —
 * lowercase, spaces, missing or doubled dashes, a pasted whole URL — but never
 * guesses at a character the suffix alphabet excludes.
 */
export function normalizeInviteCode(raw: string): string {
  const tail = raw.trim().split(/[/?#]/).filter(Boolean).pop() ?? '';
  const cleaned = tail.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length <= INVITE_SUFFIX_LENGTH) return cleaned;

  const prefix = cleaned
    .slice(0, cleaned.length - INVITE_SUFFIX_LENGTH)
    .replace(/[0-9]/g, (digit) => PREFIX_FOLD[digit] ?? digit)
    .replace(/[^A-Z]/g, '');
  const suffix = cleaned.slice(cleaned.length - INVITE_SUFFIX_LENGTH);
  return `${prefix}-${suffix}`;
}

export type InviteCodeParse =
  | { valid: true; code: string; prefix: string; suffix: string }
  | { valid: false; reason: 'empty' | 'too-short' | 'bad-characters' };

/**
 * Validates *shape* only — whether the code exists is the adapter's business.
 * Splitting the two means the join screen can say "that doesn't look like a
 * Petal code" instantly, without a round trip.
 */
export function parseInviteCode(raw: string): InviteCodeParse {
  const code = normalizeInviteCode(raw);
  if (!code) return { valid: false, reason: 'empty' };

  const [prefix = '', suffix = ''] = code.split('-');
  if (prefix.length < 2 || suffix.length !== INVITE_SUFFIX_LENGTH) {
    return { valid: false, reason: 'too-short' };
  }
  if (![...suffix].every((ch) => CODE_ALPHABET.includes(ch))) {
    return { valid: false, reason: 'bad-characters' };
  }
  return { valid: true, code, prefix, suffix };
}

export function isInviteCode(raw: string): boolean {
  return parseInviteCode(raw).valid;
}

/**
 * Live formatter for the join field: uppercases as they type and keeps a single
 * separator, without fighting them mid-word by re-anchoring the dash.
 */
export function formatInviteCodeInput(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-/, '');
  return cleaned.slice(0, INVITE_PREFIX_MAX + 1 + INVITE_SUFFIX_LENGTH);
}
