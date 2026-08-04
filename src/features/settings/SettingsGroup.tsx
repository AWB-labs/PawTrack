/**
 * Petal — SettingsGroup.
 *
 * The grouped-list card: a quiet overline, a rounded card of rows, and an
 * optional footnote underneath that explains the group rather than crowding
 * each row's subtitle.
 *
 * It does three things its children can't do for themselves:
 *
 *   · **Tells each row where it sits.** First and last draw the card's corners;
 *     everything between stays square, and only the rows that have a neighbour
 *     below draw a divider. The card clips as well, so a row that ships without
 *     a group still can't spill past the radius.
 *   · **Staggers the rows in.** `motion.stagger.base` per row, capped at eight,
 *     so a settings screen assembles itself instead of appearing. `delay` lets
 *     a screen of several groups cascade top to bottom.
 *   · **Degrades honestly.** Under reduced motion the same sequence plays as a
 *     cross-fade — the rows still arrive in order, they just don't travel.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useTheme } from '@/theme';
import { Icon, Row, Surface, Text, type IconName } from '@/ui';
import { SettingsRowPositionProvider } from './SettingsRow';

/* -------------------------------------------------------------------- types */

export type SettingsGroupProps = {
  /** Overline above the card. Omit for an unlabelled group of one or two rows. */
  title?: string;
  icon?: IconName;
  /** Footnote under the card — the place for caveats and consequences. */
  footer?: string;
  /** Milliseconds before the first row arrives, so groups cascade. */
  delay?: number;
  animate?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Past this the cascade reads as lag rather than choreography. */
const MAX_STAGGERED = 8;

/* ---------------------------------------------------------------- component */

export function SettingsGroup({
  title,
  icon,
  footer,
  delay = 0,
  animate = true,
  children,
  style,
  testID,
}: SettingsGroupProps) {
  const t = useTheme();
  const reduceMotion = t.reduceMotion;

  const rows = React.Children.toArray(children).filter(React.isValidElement);
  const count = rows.length;

  const enter = (index: number) => {
    const wait = delay + Math.min(index, MAX_STAGGERED) * t.motion.stagger.base;
    return reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(wait)
      : FadeInDown.duration(t.motion.duration.slow).delay(wait).easing(t.motion.easing.decelerate);
  };

  return (
    <View style={[{ gap: t.spacing.sm }, style]} testID={testID}>
      {title ? (
        <Row gap="xs" style={{ paddingHorizontal: t.spacing.xs }}>
          {icon ? <Icon name={icon} size="xs" color="textTertiary" /> : null}
          <Text variant="overline" color="textTertiary" accessibilityRole="header">
            {title}
          </Text>
        </Row>
      ) : null}

      <Surface
        variant="surface"
        elevation={1}
        radius="xl"
        padding="none"
        // Clipping is what guarantees the corners even for a row that was
        // dropped in without a position of its own.
        style={{ overflow: 'hidden' }}
      >
        {rows.map((child, index) => {
          const position = { first: index === 0, last: index === count - 1 };
          const content = (
            <SettingsRowPositionProvider position={position}>{child}</SettingsRowPositionProvider>
          );

          return animate ? (
            <Animated.View key={index} entering={enter(index)}>
              {content}
            </Animated.View>
          ) : (
            <View key={index}>{content}</View>
          );
        })}
      </Surface>

      {footer ? (
        <Text variant="footnote" color="textTertiary" style={{ paddingHorizontal: t.spacing.xs }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

export default SettingsGroup;
