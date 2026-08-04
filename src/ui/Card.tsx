/**
 * Petal — Card.
 *
 * A Surface that knows how to be tapped, plus the two structural pieces almost
 * every card in this app needs: header/footer slots and a leading accent bar.
 *
 * The accent bar is the reason cards feel like *pets* rather than rows: each
 * pet carries a stable identity colour from `theme.speciesColor()`, so a card
 * for Buddy is recognisable in peripheral vision before you read the name.
 *
 * Press scale is `large` (0.98) — a full-width card that shrinks 4% looks
 * broken; 2% reads as paper being pushed.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ElevationLevel } from '@/theme';
import type { RadiusToken, SpacingToken } from './Stack';
import { Surface, type SurfaceVariant } from './Surface';
import { Touchable, type PressScaleToken, type TouchableHaptic } from './Touchable';

/* -------------------------------------------------------------------- types */

export type CardProps = {
  children?: ReactNode;
  /** Rendered above the content, separated by the card's gap. */
  header?: ReactNode;
  /** Rendered below the content, with a hairline rule by default. */
  footer?: ReactNode;
  footerDivider?: boolean;
  /**
   * Leading identity bar. Pass `theme.speciesColor(pet.species).base` — or any
   * status colour when the card represents state rather than a pet.
   */
  accent?: string;

  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  haptic?: TouchableHaptic;
  pressScale?: PressScaleToken | number;

  variant?: SurfaceVariant;
  elevation?: ElevationLevel;
  radius?: RadiusToken | number;
  padding?: SpacingToken | number;
  /** Vertical rhythm between header, content and footer. */
  gap?: SpacingToken | number;
  border?: boolean;

  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/* ---------------------------------------------------------------- component */

export function Card({
  children,
  header,
  footer,
  footerDivider = true,
  accent,
  onPress,
  onLongPress,
  disabled = false,
  disabledReason,
  haptic = 'tap',
  pressScale = 'large',
  variant = 'surface',
  elevation = 1,
  radius = 'xl',
  padding = 'base',
  gap = 'md',
  border,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: CardProps) {
  const t = useTheme();
  const pad = typeof padding === 'number' ? padding : t.spacing[padding];
  const gapPx = typeof gap === 'number' ? gap : t.spacing[gap];
  // Cards on the plain background need a hairline to hold their edge; raised
  // ones don't, or they read as double-outlined.
  const hasBorder = border ?? (elevation === 0 && variant !== 'glass');

  const body = (
    <Surface
      variant={variant}
      elevation={elevation}
      radius={radius}
      padding="none"
      border={hasBorder}
      // Clipping is what lets the accent bar follow the corner radius. `grow`
      // makes a card fill a flexed cell without collapsing a content-sized one.
      style={[
        { overflow: 'hidden', flexDirection: 'row', flexGrow: 1, flexBasis: 'auto' },
        onPress ? null : style,
      ]}
      testID={testID}
    >
      {accent ? <View style={{ width: t.spacing.xxs, backgroundColor: accent }} /> : null}
      <View style={{ flex: 1, padding: pad, gap: gapPx }}>
        {header}
        {children}
        {footer ? (
          <View
            style={
              footerDivider
                ? {
                    paddingTop: gapPx,
                    borderTopWidth: t.borderWidth.hairline,
                    borderTopColor: t.color.divider,
                  }
                : null
            }
          >
            {footer}
          </View>
        ) : null}
      </View>
    </Surface>
  );

  if (!onPress && !onLongPress) return body;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic={haptic}
      onPress={onPress}
      onLongPress={onLongPress}
      pressScale={pressScale}
      style={style}
    >
      {body}
    </Touchable>
  );
}

export default Card;
