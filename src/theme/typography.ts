/**
 * Petal — type system.
 *
 * Pairing: **Fraunces** (soft variable serif) for display/titles, **Plus Jakarta
 * Sans** for everything functional. Editorial serif + geometric sans is what
 * keeps the app from reading like a stock dashboard, while the sans keeps dense
 * medical data legible.
 *
 * Dynamic type: RN scales text from the OS accessibility setting by default. We
 * keep that on everywhere but cap it *per variant* — a display title at 2×
 * would blow up a card header, while body copy genuinely needs to reach 2×. The
 * caps live here so no screen has to think about it.
 */

import { Platform, type TextStyle } from 'react-native';

export const fontFamily = {
  /** Fraunces — display & titles. */
  display: 'Fraunces_600SemiBold',
  displayBold: 'Fraunces_700Bold',
  displayItalic: 'Fraunces_600SemiBold_Italic',
  /** Plus Jakarta Sans — UI, body, data. */
  sans: 'PlusJakartaSans_400Regular',
  sansMedium: 'PlusJakartaSans_500Medium',
  sansSemi: 'PlusJakartaSans_600SemiBold',
  sansBold: 'PlusJakartaSans_700Bold',
} as const;

export type TypeVariant =
  | 'hero'
  | 'display'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'bodyStrong'
  | 'callout'
  | 'subhead'
  | 'subheadStrong'
  | 'footnote'
  | 'caption'
  | 'captionStrong'
  | 'overline'
  | 'button'
  | 'buttonSmall'
  | 'metric'
  | 'metricSmall';

export type TypeSpec = TextStyle & {
  /** Ceiling on OS font scaling for this variant. */
  maxFontSizeMultiplier: number;
};

/**
 * Optical tracking: large serif needs negative tracking to stop looking loose;
 * small caps/overline needs positive tracking to stay readable.
 */
export const typeScale: Record<TypeVariant, TypeSpec> = {
  hero: {
    fontFamily: fontFamily.displayBold,
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -0.9,
    maxFontSizeMultiplier: 1.3,
  },
  display: {
    fontFamily: fontFamily.display,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.6,
    maxFontSizeMultiplier: 1.4,
  },
  title1: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.4,
    maxFontSizeMultiplier: 1.5,
  },
  title2: {
    fontFamily: fontFamily.sansBold,
    fontSize: 21,
    lineHeight: 27,
    letterSpacing: -0.3,
    maxFontSizeMultiplier: 1.6,
  },
  title3: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.2,
    maxFontSizeMultiplier: 1.7,
  },
  headline: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.1,
    maxFontSizeMultiplier: 1.8,
  },
  body: {
    fontFamily: fontFamily.sans,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0,
    maxFontSizeMultiplier: 2,
  },
  bodyStrong: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0,
    maxFontSizeMultiplier: 2,
  },
  callout: {
    fontFamily: fontFamily.sans,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0,
    maxFontSizeMultiplier: 2,
  },
  subhead: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.05,
    maxFontSizeMultiplier: 2,
  },
  subheadStrong: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.05,
    maxFontSizeMultiplier: 2,
  },
  footnote: {
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.1,
    maxFontSizeMultiplier: 1.9,
  },
  caption: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.15,
    maxFontSizeMultiplier: 1.8,
  },
  captionStrong: {
    fontFamily: fontFamily.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.15,
    maxFontSizeMultiplier: 1.8,
  },
  overline: {
    fontFamily: fontFamily.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    maxFontSizeMultiplier: 1.6,
  },
  button: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: 0.1,
    maxFontSizeMultiplier: 1.5,
  },
  buttonSmall: {
    fontFamily: fontFamily.sansSemi,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: 0.15,
    maxFontSizeMultiplier: 1.5,
  },
  /** Big numerals — weight history, adherence %, portion sizes. */
  metric: {
    fontFamily: fontFamily.displayBold,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -0.8,
    maxFontSizeMultiplier: 1.35,
    ...(Platform.OS === 'ios' ? { fontVariant: ['tabular-nums' as const] } : null),
  },
  metricSmall: {
    fontFamily: fontFamily.sansBold,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.2,
    maxFontSizeMultiplier: 1.5,
    ...(Platform.OS === 'ios' ? { fontVariant: ['tabular-nums' as const] } : null),
  },
};

/** The font modules loaded at boot live in `./fonts.ts` (static requires). */
