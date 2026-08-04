/**
 * Petal — layout primitives.
 *
 * `<Row>` and `<Column>` exist for one reason: `gap` should be a spacing token,
 * not a number. Once every gap in the app is `gap="md"`, retuning the rhythm is
 * one edit in `tokens.ts` instead of a search for `marginBottom: 12`.
 *
 * `align`/`justify` use short names (`start`, `between`) rather than the flex
 * spellings — at a glance `justify="between"` reads as intent, where
 * `justifyContent="space-between"` reads as CSS trivia.
 *
 * This file also owns the token-name types the rest of the UI layer borrows,
 * so `SpacingToken` means exactly one thing everywhere.
 */

import React, { type ReactNode } from 'react';
import { View, type FlexStyle, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '@/theme';

/* -------------------------------------------------------------------- types */

export type SpacingToken = keyof Theme['spacing'];
export type RadiusToken = keyof Theme['radius'];

export type StackAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type StackJustify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

export type StackProps = ViewProps & {
  children?: ReactNode;
  direction?: 'row' | 'column';
  /** Spacing token, or an explicit pt value where a token genuinely doesn't fit. */
  gap?: SpacingToken | number;
  align?: StackAlign;
  justify?: StackJustify;
  wrap?: boolean;
  /** Shorthand for `flex: 1` — the single most common style on a stack. */
  flex?: boolean | number;
  style?: StyleProp<ViewStyle>;
};

export type SpacerProps = {
  /** Fixed size. Omit for a flexible spacer that eats the remaining room. */
  size?: SpacingToken | number;
  /** Constrain a fixed spacer to one axis so it can't inflate a short row. */
  axis?: 'x' | 'y' | 'both';
};

/* ---------------------------------------------------------------- constants */

const ALIGN: Record<StackAlign, FlexStyle['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

const JUSTIFY: Record<StackJustify, FlexStyle['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
};

/* --------------------------------------------------------------- components */

export function Stack({
  children,
  direction = 'column',
  gap,
  align,
  justify,
  wrap = false,
  flex,
  style,
  ...rest
}: StackProps) {
  const t = useTheme();
  const gapPx = gap === undefined ? undefined : typeof gap === 'number' ? gap : t.spacing[gap];

  return (
    <View
      style={[
        {
          flexDirection: direction,
          alignItems: align ? ALIGN[align] : undefined,
          justifyContent: justify ? JUSTIFY[justify] : undefined,
          flexWrap: wrap ? 'wrap' : undefined,
          gap: gapPx,
          flex: flex === true ? 1 : flex === false ? undefined : flex,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/** Horizontal stack. Defaults to `align="center"` — the vertical centring you
 *  want ~95% of the time when icons sit beside text. */
export function Row({ align = 'center', ...rest }: Omit<StackProps, 'direction'>) {
  return <Stack direction="row" align={align} {...rest} />;
}

/** Vertical stack. */
export function Column(props: Omit<StackProps, 'direction'>) {
  return <Stack direction="column" {...props} />;
}

/**
 * Fixed gap or flexible push. `<Spacer />` shoves siblings apart;
 * `<Spacer size="lg" />` inserts exactly 20pt.
 */
export function Spacer({ size, axis = 'both' }: SpacerProps) {
  const t = useTheme();
  if (size === undefined) return <View style={FLEX_SPACER} />;
  const px = typeof size === 'number' ? size : t.spacing[size];
  return (
    <View
      style={{
        width: axis === 'y' ? undefined : px,
        height: axis === 'x' ? undefined : px,
        flexShrink: 0,
      }}
    />
  );
}

const FLEX_SPACER: ViewStyle = { flex: 1 };

export default Stack;
