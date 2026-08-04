/**
 * Petal — Divider.
 *
 * A hairline, not a border. Two details matter:
 *
 *   · **Inset.** A rule that runs edge to edge under a list of avatars looks
 *     like a table; one that starts where the *text* starts looks like a list.
 *     `inset="content"` aligns to the text column past a 48pt leading element.
 *   · **Label.** `<Divider label="Earlier today" />` is the section break used
 *     throughout the activity and community feeds, so it lives here rather
 *     than being rebuilt per screen.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import { resolveColor, Text, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

/**
 * `gutter` matches the screen edge padding; `content` clears a 48pt avatar
 * plus its gap so the rule starts under the first character of the title.
 */
export type DividerInset = 'none' | 'gutter' | 'content';

export type DividerProps = {
  inset?: DividerInset | number;
  vertical?: boolean;
  /** Centres a small caption in a gap in the rule. */
  label?: string;
  color?: ColorProp;
  /** Vertical breathing room around a horizontal rule. */
  spacing?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- component */

export function Divider({
  inset = 'none',
  vertical = false,
  label,
  color = 'divider',
  spacing,
  style,
  testID,
}: DividerProps) {
  const t = useTheme();
  const line = resolveColor(t.color, color, t.color.divider);

  if (vertical) {
    return (
      <View
        accessibilityRole="none"
        testID={testID}
        style={[
          { width: t.borderWidth.hairline, alignSelf: 'stretch', backgroundColor: line },
          spacing === undefined ? null : { marginHorizontal: spacing },
          style,
        ]}
      />
    );
  }

  const start =
    typeof inset === 'number'
      ? inset
      : inset === 'gutter'
        ? t.gutter
        : inset === 'content'
          ? t.spacing.huge + t.spacing.md
          : 0;

  const rule: ViewStyle = { flex: 1, height: t.borderWidth.hairline, backgroundColor: line };
  const outer: StyleProp<ViewStyle> = [
    { marginLeft: start, flexDirection: 'row', alignItems: 'center' },
    spacing === undefined ? null : { marginVertical: spacing },
    style,
  ];

  if (label === undefined) {
    return <View accessibilityRole="none" testID={testID} style={outer}><View style={rule} /></View>;
  }

  return (
    <View accessibilityRole="none" testID={testID} style={outer}>
      <View style={rule} />
      <Text variant="caption" color="textTertiary" style={{ marginHorizontal: t.spacing.md }}>
        {label}
      </Text>
      <View style={rule} />
    </View>
  );
}

export default Divider;
