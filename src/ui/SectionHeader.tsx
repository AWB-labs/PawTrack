/**
 * Petal — SectionHeader.
 *
 * The label above every group in the app. It exists so that "Today", "Overdue"
 * and "Buddy's medicines" are set identically everywhere — a screen that
 * hand-rolls its own headers is how a design system starts to drift.
 *
 * `sticky` matters: a `SectionList` header floats over the content, so it needs
 * an opaque ground and a hairline it doesn't have when it's sitting inline.
 * Passing the flag here means a screen never has to remember to add both.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import { Badge, type BadgeTone } from './Badge';
import { Icon, type IconName } from './Icon';
import { Row } from './Stack';
import { Text, type ColorProp } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

/** `title` for a section inside a screen, `overline` for a quieter subdivision. */
export type SectionHeaderVariant = 'title' | 'overline';

export type SectionHeaderProps = {
  title: string;
  /** One line under the title — context, not decoration. */
  subtitle?: string;
  /** Rendered as a badge beside the title. */
  count?: number;
  countTone?: BadgeTone;
  /** Small leading icon, tinted with the title colour. */
  icon?: IconName;
  iconColor?: ColorProp;
  /** Trailing text link — "See all". */
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: IconName;
  /** Renders the link disabled and explains itself on tap. */
  actionDisabledReason?: string;
  /** Arbitrary trailing content. Takes precedence over the action link. */
  trailing?: ReactNode;
  variant?: SectionHeaderVariant;
  /** Opaque ground + hairline, for a floating `SectionList` header. */
  sticky?: boolean;
  /** Drops the leading space — for the first header on a screen. */
  first?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- component */

export function SectionHeader({
  title,
  subtitle,
  count,
  countTone = 'neutral',
  icon,
  iconColor = 'textTertiary',
  actionLabel,
  onAction,
  actionIcon = 'chevron-forward',
  actionDisabledReason,
  trailing,
  variant = 'title',
  sticky = false,
  first = false,
  style,
  testID,
}: SectionHeaderProps) {
  const t = useTheme();

  const stickyStyle: ViewStyle | null = sticky
    ? {
        backgroundColor: t.color.bg,
        borderBottomWidth: t.borderWidth.hairline,
        borderBottomColor: t.color.divider,
        paddingHorizontal: t.gutter,
        marginHorizontal: -t.gutter,
      }
    : null;

  return (
    <View
      style={[
        {
          paddingTop: first ? 0 : t.spacing.lg,
          paddingBottom: t.spacing.sm,
          gap: t.spacing.xxs,
        },
        stickyStyle,
        style,
      ]}
      testID={testID}
    >
      <Row justify="between" gap="md">
        <Row gap="sm" style={{ flexShrink: 1 }}>
          {icon ? <Icon name={icon} size="sm" color={iconColor} /> : null}
          <Text
            variant={variant === 'overline' ? 'overline' : 'title3'}
            color={variant === 'overline' ? 'textTertiary' : 'text'}
            numberOfLines={1}
            accessibilityRole="header"
            style={{ flexShrink: 1 }}
          >
            {title}
          </Text>
          {count !== undefined ? (
            <Badge count={count} tone={countTone} size="sm" accessibilityLabel={`${count} items`} />
          ) : null}
        </Row>

        {trailing ??
          (actionLabel && (onAction || actionDisabledReason !== undefined) ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
              accessibilityHint={`Opens all of ${title}`}
              disabledReason={actionDisabledReason}
              haptic="tap"
              onPress={onAction}
              pressScale="small"
            >
              <Row gap="hair">
                <Text variant="subheadStrong" color="primaryText" numberOfLines={1}>
                  {actionLabel}
                </Text>
                {actionIcon ? <Icon name={actionIcon} size="xs" color="primaryText" /> : null}
              </Row>
            </Touchable>
          ) : null)}
      </Row>

      {subtitle ? (
        <Text variant="footnote" color="textSecondary" numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export default SectionHeader;
