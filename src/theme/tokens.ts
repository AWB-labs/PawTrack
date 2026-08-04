/**
 * Petal — raw design tokens.
 *
 * These are the *primitive* scales. Nothing in the app should reference them
 * directly; screens consume the semantic layer in `palette.ts` via `useTheme()`.
 * Keeping the primitives separate is what lets us retune the brand (or add a
 * high-contrast theme) without touching a single screen.
 *
 * Colour choices are deliberate:
 *  - Neutrals are *warm* (hue ~35°), never pure grey. Grey reads clinical; a
 *    pet-care app that holds medical records needs to feel calm, not sterile.
 *  - Moss (primary) carries health/growth and is dark enough to pass AA as
 *    text at the 600 step and as a white-on-fill at the 500 step.
 *  - Blossom (accent) is a warm coral used as a *fill with dark ink*. White on
 *    coral only reaches ~3.1:1, so the semantic layer pairs it with ink
 *    instead of quietly shipping a contrast failure.
 */

/* ------------------------------------------------------------------ colour */

export const neutral = {
  0: '#FFFFFF',
  25: '#FDFBF8',
  50: '#FBF8F4',
  100: '#F4EFE8',
  150: '#EDE6DC',
  200: '#E8E0D6',
  300: '#D7CCBE',
  400: '#B5A899',
  500: '#948B7E',
  // 4.9:1 on neutral.100 — the *sunken* ground, which is the worst case a
  // tertiary label actually lands on. Tuning against neutral.50 alone leaves it
  // failing inside grouped cards.
  600: '#6E675C',
  700: '#575148',
  750: '#4A443C',
  800: '#332E26',
  850: '#272218',
  875: '#1D1A16',
  900: '#14120F',
  950: '#0C0B09',
} as const;

/** Primary — deep moss. Health, growth, quiet confidence. */
export const moss = {
  50: '#F0F5EF',
  100: '#DCE8DA',
  200: '#B9D2B6',
  300: '#8FB78B', //  8.2:1 on neutral.900 — the dark-theme primary
  400: '#6A9C66',
  500: '#4F8149', //  4.6:1 with white — the light-theme fill
  600: '#3D6738', //  6.2:1 on neutral.50 — the light-theme *text* brand colour
  700: '#2F502C',
  800: '#223B20',
  900: '#162815',
} as const;

/** Accent — warm blossom. Celebration, CTAs, the "pet" in pet care. */
export const blossom = {
  50: '#FFF3EE',
  100: '#FFE2D6',
  200: '#FFC4AC',
  300: '#FF9F7D',
  400: '#FF7E55',
  500: '#F2653A', // fill + dark ink (5.4:1). Never white ink on this step.
  600: '#D24E27',
  700: '#A93B1B', // accent-as-text on light surfaces
  800: '#7E2B14',
  900: '#551C0D',
} as const;

/** Status ramps. Amber = due soon, rose = overdue/danger, sky = info. */
export const amber = {
  50: '#FFF8E6',
  100: '#FFEDBF',
  200: '#FFDC85',
  300: '#FFC94D',
  400: '#F5AF1B',
  500: '#D9910A',
  600: '#AE7006',
  700: '#82520A',
  800: '#5A390A',
  900: '#3B2506',
} as const;

export const rose = {
  50: '#FFF1F2',
  100: '#FFE0E3',
  200: '#FFC2C8',
  300: '#FF96A0',
  400: '#F8677A',
  500: '#E23E56',
  600: '#BE2A43',
  700: '#961F35',
  800: '#6D1626',
  900: '#470E19',
} as const;

export const sky = {
  50: '#EEF4FF',
  100: '#DAE6FF',
  200: '#B7CDFF',
  300: '#8AABFA',
  400: '#5E86EF',
  500: '#4064DC',
  600: '#2F4CBA',
  700: '#253C92',
  800: '#1B2C6B',
  900: '#121D47',
} as const;

/**
 * Species accents. Every pet gets a stable identity colour so a card for
 * "Buddy" is recognisable before you read the name. Derived deterministically
 * from species + id so it never shuffles between sessions.
 */
export const species = {
  dog: { light: '#C97B1F', dark: '#F0B45E', tint: '#FDF0DC' },
  cat: { light: '#8A5CC4', dark: '#C4A2F0', tint: '#F2ECFB' },
  bird: { light: '#1E88A8', dark: '#6FCBE4', tint: '#E3F4F9' },
  rabbit: { light: '#C24C77', dark: '#F09CBC', tint: '#FBEBF1' },
  reptile: { light: '#2A8F73', dark: '#79D6BB', tint: '#E4F5F0' },
  fish: { light: '#2E7BC4', dark: '#8CC3F2', tint: '#E8F2FB' },
  smallPet: { light: '#9A7B33', dark: '#DFC178', tint: '#F7F1E0' },
  other: { light: '#6B7280', dark: '#B7BEC9', tint: '#EEF0F3' },
} as const;

export type SpeciesKey = keyof typeof species;

/* ----------------------------------------------------------------- spacing */

/**
 * 4pt base grid. Named rather than numeric-indexed so a screen reads
 * `spacing.lg` (intent) instead of `spacing[5]` (magnitude).
 */
export const spacing = {
  none: 0,
  hair: 2,
  xxs: 4,
  xs: 6,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 48,
  giant: 64,
  colossal: 80,
} as const;

/** Horizontal screen gutter. Every screen uses this — no per-screen drift. */
export const gutter = spacing.lg;

/* ------------------------------------------------------------------ radius */

export const radius = {
  none: 0,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 36,
  pill: 999,
} as const;

/* ------------------------------------------------------------ hit targets */

/**
 * Apple HIG / WCAG 2.5.5 floor. `MIN_TARGET` is enforced by the `Touchable`
 * primitive, so no screen can accidentally ship a 30pt tap area.
 */
export const MIN_TARGET = 44;

/* ------------------------------------------------------------------ layers */

export const zIndex = {
  base: 0,
  card: 1,
  sticky: 10,
  header: 20,
  fab: 30,
  sheet: 40,
  toast: 60,
  modal: 80,
  tooltip: 100,
} as const;

/* ---------------------------------------------------------------- opacity */

export const opacity = {
  disabled: 0.38,
  muted: 0.6,
  scrim: 0.55,
  scrimLight: 0.28,
  pressed: 0.9,
  divider: 0.08,
} as const;

/* ------------------------------------------------------------------ border */

export const borderWidth = {
  hairline: 1,
  thin: 1.5,
  thick: 2,
  focus: 2.5,
} as const;
