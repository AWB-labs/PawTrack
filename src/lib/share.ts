/**
 * Petal — sharing and the clipboard.
 *
 * Two different native APIs, because they do genuinely different jobs and
 * conflating them is why "share" buttons so often do nothing:
 *
 *  · `react-native`'s `Share` sends **text and links** — the invite message.
 *  · `expo-sharing` sends **files** — a vaccination card, an x-ray, an invoice.
 *    It needs a `file://` URI; handing it an https URL fails silently on iOS,
 *    so we detect that and share the link instead.
 *
 * Every path here has a fallback that still leaves the user holding the thing
 * they asked for. A share sheet that can't open falls back to the clipboard, and
 * we say so — "Copied instead" is a result; a dead button is not.
 */

import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

import { buildInviteUrl, buildInviteWebUrl } from './deeplinks';
import { logError } from './errors';
import haptics from './haptics';
import { parseInviteCode } from './id';

/* ------------------------------------------------------------------ types */

export type ShareOutcome =
  | { ok: true; via: 'sheet' | 'clipboard' }
  | { ok: false; reason: 'dismissed' | 'unavailable' | 'failed'; message: string };

export type InviteShareInput = {
  petName: string;
  code: string;
  /** Personalises the opening line when the owner named the invitee. */
  inviteeName?: string | null;
  /** The preset's `caregiverBlurb` — tells them what they'll be able to do. */
  accessBlurb?: string | null;
  /** Prefer the https twin for messages likely to be read on a laptop. */
  preferWebLink?: boolean;
};

export type DocumentShareInput = {
  /** Local `file://` URI. An https URL is shared as a link instead. */
  uri: string;
  title: string;
  mimeType?: string | null;
};

const DISMISSED = 'dismissed' as const;

/* ------------------------------------------------------------- clipboard */

/**
 * Copy, with the haptic that makes it feel like something happened. Returns
 * false rather than throwing so a copy button can show a gentle failure toast.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    haptics.success();
    return true;
  } catch (error) {
    logError('share.copyToClipboard', error);
    return false;
  }
}

/**
 * The separator is required, not optional: every code we generate has one, and
 * without it a twelve-letter word ("Congratulations") splits into a valid-
 * looking prefix and suffix.
 */
const LOOKS_LIKE_CODE = /^[A-Za-z]{2,8}[-\s][A-Za-z0-9]{4}$/;
const LOOKS_LIKE_LINK = /\/(invite|join)\//i;

/**
 * Read a Petal invite code out of the clipboard, if there is one.
 *
 * Call this **only** from an explicit user action ("Paste code"). iOS 16+ shows
 * a system paste banner on every clipboard read, and firing one on screen mount
 * looks like the app is snooping — which, from the user's side, it is.
 *
 * The shape guard before parsing is doing real work: `parseInviteCode` validates
 * the *form* of a code, and plenty of ordinary sentences ("just some text")
 * survive normalisation into something that passes. Pre-filling the join field
 * with a word from someone's clipboard is worse than not offering to at all.
 */
export async function readClipboardInviteCode(): Promise<string | null> {
  try {
    if (!(await Clipboard.hasStringAsync())) return null;
    const raw = (await Clipboard.getStringAsync()).trim();
    if (raw.length === 0 || raw.length > 200) return null;
    if (!LOOKS_LIKE_CODE.test(raw) && !LOOKS_LIKE_LINK.test(raw)) return null;

    const parsed = parseInviteCode(raw);
    return parsed.valid ? parsed.code : null;
  } catch (error) {
    logError('share.readClipboardInviteCode', error);
    return null;
  }
}

/* ---------------------------------------------------------------- invites */

/**
 * The message a caregiver actually receives. Written as one person asking
 * another for a favour, because that's what it is — not a system notification
 * with a token in it.
 */
export function inviteMessage(input: InviteShareInput): string {
  const { petName, code, inviteeName, accessBlurb } = input;
  const opener = inviteeName?.trim()
    ? `Hi ${inviteeName.trim()} — fancy helping look after ${petName}? 🐾`
    : `Fancy helping look after ${petName}? 🐾`;

  const lines = [
    opener,
    '',
    `I use Petal to keep ${petName}'s meals, medicine and vet notes in one place. Join me and you'll see exactly what's due, and I'll see it's been done.`,
  ];

  if (accessBlurb?.trim()) lines.push('', accessBlurb.trim());
  lines.push('', `Your code: ${code}`);

  return lines.join('\n');
}

/** The link that goes with the message. */
export function inviteLink(input: Pick<InviteShareInput, 'code' | 'preferWebLink'>): string {
  return input.preferWebLink ? buildInviteWebUrl(input.code) : buildInviteUrl(input.code);
}

/**
 * Open the system share sheet with the invite. Falls back to the clipboard if
 * the sheet can't be presented — the owner still walks away with something to
 * paste into a message.
 */
export async function shareInvite(input: InviteShareInput): Promise<ShareOutcome> {
  const message = inviteMessage(input);
  const url = inviteLink(input);
  return shareText(message, url);
}

/** Copy just the code, for the "tap the code to copy" affordance on the card. */
export async function copyInviteCode(code: string): Promise<ShareOutcome> {
  const ok = await copyToClipboard(code);
  return ok
    ? { ok: true, via: 'clipboard' }
    : { ok: false, reason: 'failed', message: 'The clipboard wouldn’t take it. Try the share button instead.' };
}

/** Copy the full link, for pasting into a chat the share sheet doesn't list. */
export async function copyInviteLink(input: Pick<InviteShareInput, 'code' | 'preferWebLink'>): Promise<ShareOutcome> {
  const ok = await copyToClipboard(inviteLink(input));
  return ok
    ? { ok: true, via: 'clipboard' }
    : { ok: false, reason: 'failed', message: 'The clipboard wouldn’t take it. Try the share button instead.' };
}

/* -------------------------------------------------------------- generic */

/**
 * Share a message plus a link.
 *
 * iOS renders `message` and `url` as separate items and lets each target pick
 * what it wants; Android ignores `url` entirely, so it has to be folded into
 * the text — passing both on Android is how links go missing from shares.
 */
export async function shareText(message: string, url?: string): Promise<ShareOutcome> {
  try {
    const content =
      Platform.OS === 'ios' && url
        ? { message, url }
        : { message: url ? `${message}\n\n${url}` : message };

    const result = await Share.share(content);
    if (result.action === Share.dismissedAction) {
      return { ok: false, reason: DISMISSED, message: '' };
    }
    haptics.success();
    return { ok: true, via: 'sheet' };
  } catch (error) {
    logError('share.shareText', error);
    const fallback = await copyToClipboard(url ? `${message}\n\n${url}` : message);
    return fallback
      ? { ok: true, via: 'clipboard' }
      : {
          ok: false,
          reason: 'failed',
          message: 'The share sheet wouldn’t open and the clipboard didn’t take it either. Try again in a moment.',
        };
  }
}

/* ------------------------------------------------------------- documents */

/** iOS wants a UTI, Android wants the MIME type. Map the formats we actually store. */
const UTI_BY_MIME: Record<string, string | undefined> = {
  'application/pdf': 'com.adobe.pdf',
  'image/jpeg': 'public.jpeg',
  'image/png': 'public.png',
  'image/heic': 'public.heic',
  'image/heif': 'public.heic',
  'image/webp': 'org.webmproject.webp',
  'text/plain': 'public.plain-text',
};

export async function canShareFiles(): Promise<boolean> {
  try {
    return await Sharing.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Export a stored document to another app — mail, Files, a vet's portal.
 *
 * A remote URL is shared as a *link* rather than failing: `expo-sharing` only
 * handles local files, and silently doing nothing is the worst possible answer
 * to "send this x-ray to my vet".
 */
export async function shareDocument(input: DocumentShareInput): Promise<ShareOutcome> {
  const { uri, title, mimeType } = input;

  if (!uri.startsWith('file://') && !uri.startsWith('content://')) {
    return shareText(title, uri);
  }

  if (!(await canShareFiles())) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'This device can’t open a share sheet for files. You can still view the document inside Petal.',
    };
  }

  try {
    await Sharing.shareAsync(uri, {
      dialogTitle: title,
      mimeType: mimeType ?? 'application/octet-stream',
      UTI: (mimeType ? UTI_BY_MIME[mimeType] : undefined) ?? 'public.data',
    });
    haptics.success();
    return { ok: true, via: 'sheet' };
  } catch (error) {
    logError('share.shareDocument', error);
    return {
      ok: false,
      reason: 'failed',
      message: 'That file wouldn’t hand over to another app. Try again, or open it in Petal and screenshot it.',
    };
  }
}

/** True when the outcome shouldn't produce any UI — the user backed out themselves. */
export function isDismissed(outcome: ShareOutcome): boolean {
  return !outcome.ok && outcome.reason === DISMISSED;
}

export const share = {
  copyToClipboard,
  readClipboardInviteCode,
  inviteMessage,
  inviteLink,
  shareInvite,
  copyInviteCode,
  copyInviteLink,
  shareText,
  canShareFiles,
  shareDocument,
  isDismissed,
};

export default share;
