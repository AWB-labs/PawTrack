/**
 * Petal — objectionable content filter.
 *
 * The first of the four things the App Store requires of an app with a public
 * feed (agreement, filter, flag, block). This is the *filter*: it runs on the
 * text of every post and comment before it is sent, and again inside both
 * adapters so a screen that forgets to call it still cannot write. The database
 * runs the same check a third time (`petal_blocked_term` in 0008), which
 * is the only one an attacker talking to PostgREST directly cannot skip.
 *
 * Three decisions worth knowing:
 *
 *   · **Normalisation is the whole game.** Nobody types a slur cleanly when
 *     they know a filter exists — they type it spaced out, with a zero for the
 *     o, or with eight of the last letter. So the text is folded down to bare
 *     letters before a single term is compared, and the terms are matched on
 *     word boundaries against that folded form.
 *   · **Word boundaries are not optional.** A filter that blocks "Scunthorpe",
 *     "assess" or a cat called Titus is a filter people route around rather
 *     than obey. Every term here is matched as a whole word (or as an explicit
 *     phrase), never as a substring.
 *   · **Two verdicts, not one.** `block` is content we refuse to store —
 *     slurs, sexual content, threats, animal cruelty. `warn` is content worth a
 *     second thought — insults, self-harm language — where a human sentence
 *     ("this reads as an insult; still post it?") does more good than a wall.
 *     Only `block` is enforced at the data layer.
 *
 * The list is deliberately compact and English-first. It is a floor, not a
 * ceiling: `moderation_terms` in the database is the version operations can
 * extend without shipping a build, and reports from real people (see
 * `reportContent`) are what catch everything a wordlist never will.
 */

/* -------------------------------------------------------------------- types */

export type ModerationCategory =
  | 'hate'
  | 'harassment'
  | 'sexual'
  | 'violence'
  | 'animalCruelty'
  | 'selfHarm'
  | 'spam';

export type ModerationVerdict = 'allow' | 'warn' | 'block';

export type ModerationResult = {
  verdict: ModerationVerdict;
  /** Every category that matched, most severe first. Empty when allowed. */
  categories: ModerationCategory[];
  /** A sentence that can be shown to a person without editing. */
  message: string | null;
  /** What matched, for the report we file when something is blocked. */
  matches: string[];
};

type Rule = {
  category: ModerationCategory;
  verdict: Exclude<ModerationVerdict, 'allow'>;
  /** Whole words, already folded — see `fold()`. Spaces mean a literal phrase. */
  terms: readonly string[];
};

/* ---------------------------------------------------------------- the list */

/**
 * Folded forms only: lowercase, no punctuation, no accents. `fold()` is applied
 * to the input before matching, so "F.U.C.K" and "fuuuck" both arrive here as
 * "fuck" and neither needs its own entry.
 */
const RULES: readonly Rule[] = [
  {
    category: 'hate',
    verdict: 'block',
    terms: [
      'nigger', 'nigga', 'coon', 'jigaboo',
      'faggot', 'dyke', 'tranny', 'shemale',
      'kike', 'spic', 'wetback', 'chink', 'gook', 'raghead', 'towelhead',
      'retard', 'retarded', 'mongoloid',
      'white power', 'gas the', 'heil hitler', 'sieg heil',
    ],
  },
  {
    category: 'sexual',
    verdict: 'block',
    terms: [
      'porn', 'pornhub', 'nudes', 'onlyfans', 'camgirl', 'escort service',
      'blowjob', 'handjob', 'anal sex', 'cumshot', 'creampie', 'deepthroat',
      'dick pic', 'send nudes', 'sex chat', 'sexcam',
      'bestiality', 'zoophilia', 'animal porn',
      'child porn', 'loli', 'shota',
    ],
  },
  {
    category: 'violence',
    verdict: 'block',
    terms: [
      'kill yourself', 'kys', 'kill you', 'kill your family',
      'rape you', 'shoot you', 'stab you', 'beat you to death',
      'hunt you down', 'burn your house', 'i know where you live',
      'bomb threat', 'school shooting',
    ],
  },
  {
    category: 'animalCruelty',
    verdict: 'block',
    terms: [
      'dog fighting', 'dogfighting', 'cock fighting', 'bait dog',
      'kick the dog', 'kick your dog', 'beat the dog', 'beat your dog',
      'drown the puppies', 'drown the kittens', 'poison the cat', 'poison your dog',
      'how to hurt a dog', 'how to hurt a cat', 'shoot the cat', 'starve the dog',
    ],
  },
  {
    category: 'harassment',
    verdict: 'warn',
    terms: [
      'bitch', 'bastard', 'cunt', 'whore', 'slut', 'douchebag',
      'moron', 'idiot', 'imbecile', 'scumbag',
      'shut the fuck up', 'stfu', 'fuck you', 'fuck off', 'piss off',
      'go die', 'nobody likes you', 'worthless',
    ],
  },
  {
    category: 'selfHarm',
    verdict: 'warn',
    terms: [
      'kill myself', 'end my life', 'want to die', 'suicidal', 'self harm',
      'cutting myself', 'no reason to live',
    ],
  },
  {
    category: 'spam',
    verdict: 'warn',
    terms: [
      'make money fast', 'work from home', 'crypto giveaway', 'free bitcoin',
      'click this link', 'dm me for', 'whatsapp me', 'telegram me',
      'buy followers', 'promo code', 'limited time offer',
    ],
  },
];

/** Most severe first — decides which category names the message. */
const SEVERITY: readonly ModerationCategory[] = [
  'hate',
  'sexual',
  'violence',
  'animalCruelty',
  'harassment',
  'selfHarm',
  'spam',
];

/**
 * What a person is told. Written to be readable by the person who tripped it,
 * not by us: each one says what the rule is and what to do next, and none of
 * them repeats the phrase back at them.
 */
const MESSAGES: Record<ModerationCategory, string> = {
  hate: 'This reads as a slur or hate speech, and there is no version of that we publish. Rewrite it and try again.',
  sexual: 'Petal is a pet community, and sexual content isn’t allowed anywhere in it.',
  violence:
    'This reads as a threat. Threatening or wishing harm on somebody costs an account, not just a post.',
  animalCruelty:
    'This describes harming an animal — the one thing this community exists to be the opposite of.',
  harassment: 'This reads as an insult aimed at a person. Have another look before you send it.',
  selfHarm:
    'That sounds heavy, and we’re glad you said it somewhere. A feed can’t help the way a person can — please talk to someone you trust, or a crisis line where you live.',
  spam: 'This reads as promotion rather than a post. Keep it about the animals and it’ll be fine.',
};

/* --------------------------------------------------------------- character */

/**
 * Homoglyph and leetspeak folding. Deliberately one-way and lossy: the folded
 * string is only ever compared against the list, never shown or stored.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

/** Combining marks left behind by NFKD, stripped so "ñ" folds to "n". */
const COMBINING = /[̀-ͯ]/g;

/** Zero-width and direction marks — the oldest trick for splitting a word. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Fold text to bare, single-spaced lowercase letters.
 *
 * The middle step is the one that matters: single letters separated by
 * punctuation are pulled back together, so "f.u.c.k" is one word again while
 * "I. Am. Tired." survives untouched because its pieces aren't all single
 * letters.
 *
 * Letter runs are *not* squashed here — see `variants()` for why that needs to
 * be two strings rather than one.
 */
export function fold(input: string): string {
  const base = input.normalize('NFKD').replace(COMBINING, '').replace(INVISIBLE, '').toLowerCase();

  let mapped = '';
  for (const character of base) mapped += SUBSTITUTIONS[character] ?? character;

  return mapped
    .replace(/\b([a-z])(?:[^a-z0-9]+([a-z])\b)+/g, (match) => match.replace(/[^a-z0-9]/g, ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The two strings a term list has to be checked against.
 *
 * Padding a word out — "fuuuuck", "niiiigger" — has to be undone, but there is
 * no single collapse that is right for every word. Squashing runs to one length
 * turns "cool" into "col"; leaving them turns "fuuuck" into a word no list
 * contains. So both readings are produced and a term matching *either* counts:
 *
 *   · the fold as written, which keeps genuine doubles ("bass", "cool"), and
 *   · the same fold with runs of three or more squashed to a single letter,
 *     which is what recovers a padded word.
 *
 * Squashing only the runs a person would never type by accident is what keeps
 * the second reading from inventing matches: "con" is never derived from "coon",
 * because a run of two is left alone in both.
 */
function variants(input: string): [string, string] {
  const folded = fold(input);
  return [folded, folded.replace(/([a-z])\1{2,}/g, '$1')];
}

/* ---------------------------------------------------------------- matching */

/** Escapes a folded term for use inside a `RegExp`. Terms are ASCII, so this is small. */
const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Built once, at module load. A rule's terms become one alternation with word
 * boundaries at both ends, which is what keeps "Scunthorpe" and "assess" out of
 * the results while still catching a slur standing on its own.
 */
const PATTERNS: readonly { rule: Rule; pattern: RegExp }[] = RULES.map((rule) => ({
  rule,
  pattern: new RegExp(`\\b(?:${rule.terms.map(escape).join('|')})\\b`, 'g'),
}));

const rank = (category: ModerationCategory): number => SEVERITY.indexOf(category);

const ALLOWED: ModerationResult = { verdict: 'allow', categories: [], message: null, matches: [] };

/**
 * Check a body of text. Cheap enough to run on every keystroke if you want to,
 * though the call sites run it on submit — a filter that scolds you mid-word is
 * worse than one that waits until you've finished the sentence.
 */
export function moderateText(input: string): ModerationResult {
  const readings = variants(input);
  if (readings[0].length === 0) return ALLOWED;

  const hits = new Map<ModerationCategory, { verdict: 'warn' | 'block'; matches: Set<string> }>();

  for (const { rule, pattern } of PATTERNS) {
    const found = readings.flatMap((reading) => {
      pattern.lastIndex = 0;
      return reading.match(pattern) ?? [];
    });
    if (found.length === 0) continue;
    const existing = hits.get(rule.category);
    if (existing) for (const term of found) existing.matches.add(term);
    else hits.set(rule.category, { verdict: rule.verdict, matches: new Set(found) });
  }

  if (hits.size === 0) return ALLOWED;

  const categories = [...hits.keys()].sort((a, b) => rank(a) - rank(b));
  const worst =
    categories.find((category) => hits.get(category)?.verdict === 'block') ?? categories[0]!;
  const verdict: ModerationVerdict = hits.get(worst)?.verdict ?? 'warn';

  return {
    verdict,
    categories,
    message: MESSAGES[worst],
    matches: categories.flatMap((category) => [...(hits.get(category)?.matches ?? [])]),
  };
}

/** `true` when the text must not be stored. The data layer's only question. */
export function isBlocked(input: string): boolean {
  return moderateText(input).verdict === 'block';
}

/**
 * Thrown by both adapters when blocked text reaches them. Carries the same
 * sentence the composer would have shown, so a caller that skipped the check
 * still ends up telling the person something true.
 */
export class BlockedContentError extends Error {
  readonly categories: ModerationCategory[];
  readonly matches: string[];

  constructor(result: ModerationResult) {
    super(result.message ?? 'That breaks the community rules.');
    this.name = 'BlockedContentError';
    this.categories = result.categories;
    this.matches = result.matches;
  }
}

/** Guard for both adapters. Throws `BlockedContentError`, or returns the text. */
export function assertPublishable(input: string): string {
  const result = moderateText(input);
  if (result.verdict === 'block') throw new BlockedContentError(result);
  return input;
}

export default { moderateText, isBlocked, assertPublishable, fold };
