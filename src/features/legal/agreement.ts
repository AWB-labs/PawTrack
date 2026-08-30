/**
 * Furry Tracker — the agreement.
 *
 * One module holding the end-user licence agreement's *identity*: which version
 * is current, where the full text lives, and the rules a person is agreeing to
 * in the words they see on screen. Everything that presents or records the
 * agreement reads from here, so there is exactly one place to edit when the
 * terms change and exactly one number to bump.
 *
 * Bumping `TERMS_VERSION` re-gates every account on next launch: the router's
 * legal branch compares the number stored on the profile with this one, and any
 * account behind it sees the agreement again before it can reach the community.
 * That is the whole mechanism — do not add a second flag.
 *
 * The zero-tolerance sentence is not decoration and is not optional. Apple's
 * Guideline 1.2 requires that a user-generated-content app make the consequence
 * explicit *before* somebody registers, and this is the copy that does it.
 */

/* ---------------------------------------------------------------- version */

/**
 * Bump on any substantive change to the rules below or to the hosted terms.
 * v1 — 30 August 2026: first published agreement with community standards.
 */
export const TERMS_VERSION = 1;

export const TERMS_EFFECTIVE = '30 August 2026';

/* ------------------------------------------------------------------- links */

const DOCS_ORIGIN = 'https://awb-labs.github.io/PawTrack';

export const LEGAL_URLS = {
  terms: `${DOCS_ORIGIN}/terms.html`,
  privacy: `${DOCS_ORIGIN}/privacy-policy.html`,
  guidelines: `${DOCS_ORIGIN}/community-guidelines.html`,
  support: `${DOCS_ORIGIN}/support.html`,
} as const;

/** Where a report that needs a human goes, and the address on every rules page. */
export const SAFETY_ADDRESS = 'aliezz140@gmail.com';

/** Published commitment, restated in the app so it isn't only in a policy page. */
export const REVIEW_WINDOW_HOURS = 24;

/* -------------------------------------------------------------------- copy */

export type AgreementClause = {
  key: string;
  icon: string;
  title: string;
  body: string;
};

/**
 * The rules, as a person meets them. Deliberately five: a list somebody scrolls
 * past is worse than four sentences they actually read, and every one of these
 * maps to something the app can and does enforce.
 */
export const COMMUNITY_RULES: readonly AgreementClause[] = [
  {
    key: 'objectionable',
    icon: 'ban-outline',
    title: 'Zero tolerance for objectionable content',
    body:
      'No harassment, hate speech, threats, sexual content, or anything showing or encouraging cruelty to an animal. There is no warning tier for these and no context that makes them fine — content like this is removed and the account that posted it is ejected.',
  },
  {
    key: 'abuse',
    icon: 'person-remove-outline',
    title: 'Zero tolerance for abusive users',
    body:
      'Targeting a person — pile-ons, unwanted contact, impersonation, dragging someone back after they have blocked you — ends an account, not just a post.',
  },
  {
    key: 'report',
    icon: 'flag-outline',
    title: 'Flag anything that crosses the line',
    body:
      'Every post and every comment has a report control. Reports go to a person, not a queue nobody reads, and we act on them within 24 hours — removing the content and ejecting whoever posted it where that is the answer.',
  },
  {
    key: 'block',
    icon: 'hand-left-outline',
    title: 'Block, and they are gone',
    body:
      'Blocking somebody removes their posts and comments from your feed instantly, both ways, and tells us why you did it. You never have to explain yourself to use it.',
  },
  {
    key: 'yours',
    icon: 'shield-checkmark-outline',
    title: 'Your records stay yours',
    body:
      'Nothing in your pets’ health records is part of the community. Only what you deliberately post is public, and you can take any of it down at any time.',
  },
];

/**
 * What sits beside the checkbox — the line a reviewer will look for, split the
 * way the control renders it: the agreement itself at body weight, and the
 * consequence underneath it. Kept here rather than inline so the sign-up form
 * and the gate cannot drift apart.
 */
export const AGREEMENT_CONSENT =
  'I agree to the Terms of Use (EULA), the Privacy Policy, and the Community Rules.';

export const AGREEMENT_CONSEQUENCE =
  'I understand Furry Tracker has zero tolerance for objectionable content and abusive users, and that posting either removes my content and ends my account.';

export const AGREEMENT_SUMMARY =
  'Furry Tracker has a public community feed. Before you join it, these are the rules — all of them enforced, none of them decorative.';

/** Shown wherever we ask somebody to trust the process rather than just leave. */
export const REVIEW_PROMISE = `Reported content is reviewed within ${REVIEW_WINDOW_HOURS} hours. Anything that breaks these rules is removed, and the account behind it is ejected.`;

export default {
  TERMS_VERSION,
  TERMS_EFFECTIVE,
  LEGAL_URLS,
  SAFETY_ADDRESS,
  REVIEW_WINDOW_HOURS,
  COMMUNITY_RULES,
  AGREEMENT_CONSENT,
  AGREEMENT_CONSEQUENCE,
  AGREEMENT_SUMMARY,
  REVIEW_PROMISE,
};
