/**
 * Petal — semantic colour layer.
 *
 * Screens only ever read from here. Two hand-tuned schemes: dark is *designed*,
 * not inverted — it uses a warm near-black (#14120F) rather than pure black,
 * lifts the brand from moss.500 to moss.300 so it keeps 8:1 on the dark
 * ground, and re-tints surfaces upward instead of downward.
 *
 * Every `fg`/`on*` pairing below has been checked to ≥4.5:1 for body text and
 * ≥3:1 for large text / non-text UI. `assertContrast()` in `contrast.ts` guards
 * these in development so a future retune cannot silently regress them.
 */

import { amber, blossom, moss, neutral, opacity, rose, sky, species } from './tokens';

export type ColorScheme = 'light' | 'dark';

export type Palette = {
  scheme: ColorScheme;

  /** Page background, behind everything. */
  bg: string;
  /** Slightly recessed ground for grouped-list screens. */
  bgSunken: string;
  /** Default card / sheet ground. */
  surface: string;
  /** Secondary surface for nested cards, inputs, chips. */
  surfaceAlt: string;
  /** Raised surface for sheets, menus, tooltips. */
  surfaceRaised: string;
  /** Translucent glass fill used under expo-blur. */
  surfaceGlass: string;

  border: string;
  borderStrong: string;
  divider: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  /** Decorative only — below AA for body copy. Never use for essential text. */
  textFaint: string;
  textInverse: string;

  /** Brand fill (buttons, active states). Pair with `onPrimary`. */
  primary: string;
  primaryHover: string;
  primaryPressed: string;
  onPrimary: string;
  /** Brand as *text/icon* on a light or dark ground. */
  primaryText: string;
  /** Low-emphasis brand wash for chips, selected rows, badges. */
  primarySoft: string;
  primarySoftBorder: string;
  onPrimarySoft: string;

  accent: string;
  onAccent: string;
  accentText: string;
  accentSoft: string;
  onAccentSoft: string;

  success: string;
  onSuccess: string;
  successSoft: string;
  onSuccessSoft: string;

  warning: string;
  onWarning: string;
  warningSoft: string;
  onWarningSoft: string;

  danger: string;
  onDanger: string;
  dangerSoft: string;
  onDangerSoft: string;

  info: string;
  onInfo: string;
  infoSoft: string;
  onInfoSoft: string;

  /** Focus ring — must hit 3:1 against both adjacent surfaces. */
  focus: string;
  /** Modal / sheet backdrop. */
  scrim: string;
  /** Skeleton base + moving highlight. */
  skeleton: string;
  skeletonSheen: string;

  /** Tab bar & header chrome. */
  chrome: string;
  chromeBorder: string;

  /** Species identity colours, pre-resolved for this scheme. */
  species: Record<keyof typeof species, { base: string; tint: string }>;
};

const speciesFor = (scheme: ColorScheme) =>
  Object.fromEntries(
    Object.entries(species).map(([key, value]) => [
      key,
      scheme === 'light'
        ? { base: value.light, tint: value.tint }
        : { base: value.dark, tint: 'rgba(255,255,255,0.07)' },
    ]),
  ) as Palette['species'];

export const lightPalette: Palette = {
  scheme: 'light',

  bg: neutral[50],
  bgSunken: neutral[100],
  surface: neutral[0],
  surfaceAlt: neutral[100],
  surfaceRaised: neutral[0],
  surfaceGlass: 'rgba(255,255,255,0.72)',

  border: neutral[200],
  borderStrong: neutral[300],
  divider: 'rgba(28,26,23,0.08)',

  text: '#1C1A17',
  textSecondary: neutral[700],
  textTertiary: neutral[600],
  textFaint: neutral[500],
  textInverse: neutral[25],

  primary: moss[500],
  primaryHover: moss[600],
  primaryPressed: moss[700],
  onPrimary: '#FFFFFF',
  primaryText: moss[600],
  primarySoft: moss[50],
  primarySoftBorder: moss[100],
  onPrimarySoft: moss[700],

  accent: blossom[500],
  onAccent: '#2A1408',
  accentText: blossom[700],
  accentSoft: blossom[50],
  onAccentSoft: blossom[800],

  success: moss[500],
  onSuccess: '#FFFFFF',
  successSoft: moss[50],
  onSuccessSoft: moss[700],

  warning: amber[400],
  onWarning: '#2E1E02',
  warningSoft: amber[50],
  onWarningSoft: amber[800],

  // rose.500 only reaches 4.2:1 against white, so the destructive fill steps
  // down to 600 (5.8:1). A confirm-delete button is the last place to ship a
  // borderline label.
  danger: rose[600],
  onDanger: '#FFFFFF',
  dangerSoft: rose[50],
  onDangerSoft: rose[800],

  info: sky[500],
  onInfo: '#FFFFFF',
  infoSoft: sky[50],
  onInfoSoft: sky[800],

  focus: moss[600],
  scrim: `rgba(28,22,15,${opacity.scrim})`,
  skeleton: neutral[150],
  skeletonSheen: 'rgba(255,255,255,0.85)',

  chrome: 'rgba(251,248,244,0.86)',
  chromeBorder: 'rgba(28,26,23,0.07)',

  species: speciesFor('light'),
};

export const darkPalette: Palette = {
  scheme: 'dark',

  bg: neutral[900],
  bgSunken: neutral[950],
  surface: neutral[875],
  surfaceAlt: neutral[850],
  surfaceRaised: '#2A251D',
  surfaceGlass: 'rgba(29,26,22,0.72)',

  border: neutral[800],
  borderStrong: neutral[750],
  divider: 'rgba(245,241,234,0.10)',

  text: '#F5F1EA',
  textSecondary: '#A8A096',
  // Lifted from #8A8377: tertiary has to clear AA on `surfaceAlt` (#272218),
  // the densest ground it sits on, not just on the page background.
  textTertiary: '#948D80',
  textFaint: '#6E675C',
  textInverse: '#14120F',

  primary: moss[300],
  primaryHover: moss[200],
  primaryPressed: moss[400],
  onPrimary: '#12210F',
  primaryText: moss[300],
  primarySoft: 'rgba(143,183,139,0.14)',
  primarySoftBorder: 'rgba(143,183,139,0.26)',
  onPrimarySoft: moss[200],

  accent: blossom[300],
  onAccent: '#3A1508',
  accentText: blossom[300],
  accentSoft: 'rgba(255,159,125,0.15)',
  onAccentSoft: blossom[200],

  success: moss[300],
  onSuccess: '#12210F',
  successSoft: 'rgba(143,183,139,0.14)',
  onSuccessSoft: moss[200],

  warning: amber[300],
  onWarning: '#2E1E02',
  warningSoft: 'rgba(255,201,77,0.14)',
  onWarningSoft: amber[200],

  danger: rose[300],
  onDanger: '#3D0A14',
  dangerSoft: 'rgba(255,150,160,0.14)',
  onDangerSoft: rose[200],

  info: sky[300],
  onInfo: '#0B1533',
  infoSoft: 'rgba(138,171,250,0.14)',
  onInfoSoft: sky[200],

  focus: moss[200],
  scrim: 'rgba(0,0,0,0.66)',
  skeleton: '#262218',
  skeletonSheen: 'rgba(255,255,255,0.07)',

  chrome: 'rgba(20,18,15,0.84)',
  chromeBorder: 'rgba(245,241,234,0.09)',

  species: speciesFor('dark'),
};

export const palettes: Record<ColorScheme, Palette> = {
  light: lightPalette,
  dark: darkPalette,
};
