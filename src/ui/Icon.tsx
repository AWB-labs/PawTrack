/**
 * Petal — Icon.
 *
 * A thin, opinionated wrapper over Ionicons. Thin because the glyph set is
 * already good; opinionated because sizes and colours must come from the
 * system, not from whatever number felt right in the moment.
 *
 * We import the single `Ionicons` entry point rather than the barrel so the
 * other twelve icon fonts never reach the bundle.
 */

import React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/theme';
import { resolveColor, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

/** Every Ionicons glyph name, exported so props elsewhere can be typed. */
export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export type IconProps = {
  name: IconName;
  /** Named step, or an explicit pt value for one-off optical fits. */
  size?: IconSize | number;
  color?: ColorProp;
  style?: StyleProp<TextStyle>;
  /**
   * Icons are decorative by default — the label next to them carries the
   * meaning. Set this only when the icon *is* the meaning and nothing else
   * says it.
   */
  accessibilityLabel?: string;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/**
 * Six steps, each aligned to a text size it sits beside: `sm` next to caption,
 * `md` next to body, `lg` next to title3. Anything between two steps is a sign
 * the layout, not the icon, needs adjusting.
 */
export const ICON_SIZE: Record<IconSize, number> = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
  xxl: 34,
};

/* ---------------------------------------------------------------- component */

export function Icon({ name, size = 'md', color = 'text', style, accessibilityLabel, testID }: IconProps) {
  const t = useTheme();
  const px = typeof size === 'number' ? size : ICON_SIZE[size];

  return (
    <Ionicons
      name={name}
      size={px}
      color={resolveColor(t.color, color, t.color.text)}
      style={style}
      testID={testID}
      // Ionicons renders as text; without this a screen reader announces the
      // private-use glyph as gibberish.
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel !== undefined ? 'image' : 'none'}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
      allowFontScaling={false}
    />
  );
}

export default Icon;
