/**
 * Petal — Text.
 *
 * The only text primitive in the app (contract rule 2). It exists so three
 * things can't be got wrong on a per-screen basis:
 *
 *   · **The ramp.** `variant` carries family, size, leading and optical
 *     tracking together — you can't pick a size without its line height.
 *   · **Dynamic type.** Every variant declares its own scaling ceiling in
 *     `typography.ts`; we apply it here so a `hero` can't grow to 2× and blow
 *     out a card while `body` still gets the full accessibility range.
 *   · **Colour.** Semantic tokens resolve per scheme, so dark mode needs no
 *     thought at the call site.
 *
 * `resolveColor` and `ColorProp` live here rather than in the theme because
 * they describe the *prop* contract every UI primitive shares, not the palette.
 */

import React from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useTheme, type Palette, type TypeVariant } from '@/theme';

/* -------------------------------------------------------------------- types */

/** Keys of the palette whose value is a plain colour string. */
type StringValued<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T];

/** Every semantic colour token — `'text'`, `'primarySoft'`, `'onDanger'`, … */
export type ColorToken = Exclude<StringValued<Palette>, 'scheme'>;

/**
 * A palette token, or any resolved colour string. The loose half of the union
 * is deliberate: species identity colours and chart series arrive as `string`
 * from the theme, and forcing a cast at 40 call sites would be worse than
 * losing exhaustiveness here. Autocomplete still offers the tokens first.
 */
export type ColorProp = ColorToken | (string & {});

export type TextAlign = 'auto' | 'left' | 'right' | 'center' | 'justify';

export type TextProps = RNTextProps & {
  /** Position on the type ramp. Defaults to `body`. */
  variant?: TypeVariant;
  /** Semantic token or literal colour. Defaults to `text`. */
  color?: ColorProp;
  align?: TextAlign;
  /**
   * Lining, fixed-width figures. Use for anything that changes in place —
   * counters, timers, weights — so digits don't jitter as they tick.
   */
  tabular?: boolean;
  ref?: React.Ref<React.ComponentRef<typeof RNText>>;
};

/* ---------------------------------------------------------------- constants */

/**
 * `fontVariant` is only honoured on iOS in RN; on Android the `metric*` ramp
 * already ships bold figures that are near enough to tabular. Matches the
 * guard used in `typography.ts` so the two never disagree.
 */
const TABULAR: TextStyle | null = Platform.OS === 'ios' ? { fontVariant: ['tabular-nums'] } : null;

/* ---------------------------------------------------------------- component */

export function Text({
  variant = 'body',
  color = 'text',
  align,
  tabular = false,
  style,
  allowFontScaling,
  maxFontSizeMultiplier,
  ref,
  ...rest
}: TextProps) {
  const t = useTheme();
  const { maxFontSizeMultiplier: variantCap, ...typeStyle } = t.type[variant];

  return (
    <RNText
      ref={ref}
      allowFontScaling={allowFontScaling ?? true}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? variantCap}
      style={[
        typeStyle,
        { color: resolveColor(t.color, color, t.color.text) },
        align ? { textAlign: align } : null,
        tabular ? TABULAR : null,
        style,
      ]}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * Turn a `ColorProp` into a real colour. Token names win over literals, which
 * is why `'text'` can never accidentally mean the CSS keyword.
 */
export function resolveColor(palette: Palette, value: ColorProp | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const token = palette[value as ColorToken];
  return typeof token === 'string' ? token : value;
}

export default Text;
