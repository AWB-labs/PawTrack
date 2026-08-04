/**
 * Petal — ListRow.
 *
 * The standard tappable row: settings, pet pickers, medicine lists, document
 * lists, caregiver lists. Everything about it is one decision made once —
 * leading slot width, the gap to the text column, where the chevron sits, how
 * the divider insets so it starts under the *title* rather than under the icon.
 *
 * Two behaviours worth knowing:
 *
 *   · **`disabledReason` beats `disabled`.** An RBAC-gated row stays pressable
 *     and explains itself; only rows the user could fix themselves get the hard
 *     `disabled`.
 *   · **The chevron is inferred.** A row with `onPress` and no trailing content
 *     gets one; a row with a switch or a badge does not. Screens shouldn't have
 *     to remember that rule.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Row } from './Stack';
import { Text, type ColorProp } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type ListRowSize = 'dense' | 'comfortable';
export type ListRowIconTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  /** Third line — quieter still. "Logged by Priya, 2h ago". */
  caption?: string;
  /** Leading glyph in a tinted rounded square. */
  icon?: IconName;
  iconTone?: ListRowIconTone;
  /** Custom leading element — an `<Avatar/>`, an emoji, a colour swatch. */
  leading?: ReactNode;
  /** Right-aligned value text. */
  value?: string;
  /** Second line under the value — "due Friday". */
  valueCaption?: string;
  valueColor?: ColorProp;
  /** Trailing control (switch, badge, chip). Suppresses the chevron. */
  trailing?: ReactNode;
  /** Force the chevron on or off. Defaults to "on when tappable and free". */
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Tints the title — for "Delete Buddy" style rows. */
  destructive?: boolean;
  selected?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  size?: ListRowSize;
  /** Hairline under the row, inset to the text column. */
  divider?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ------------------------------------------------------------------ helpers */

function iconSkin(t: Theme, tone: ListRowIconTone) {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

/* ---------------------------------------------------------------- component */

export function ListRow({
  title,
  subtitle,
  caption,
  icon,
  iconTone = 'primary',
  leading,
  value,
  valueCaption,
  valueColor = 'textSecondary',
  trailing,
  chevron,
  onPress,
  onLongPress,
  destructive = false,
  selected = false,
  disabled = false,
  disabledReason,
  size = 'comfortable',
  divider = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ListRowProps) {
  const t = useTheme();

  const dense = size === 'dense';
  const padY = dense ? t.spacing.sm : t.spacing.md;
  const gap = t.spacing.md;
  const badgeSize = dense ? t.spacing.xxl : t.spacing.xxxl;
  const skin = iconSkin(t, destructive ? 'danger' : iconTone);

  const tappable = Boolean(onPress || onLongPress) || disabledReason !== undefined;
  const showChevron = chevron ?? (tappable && trailing === undefined && value === undefined);

  const hasLeading = leading !== undefined || icon !== undefined;
  /** The rule that makes a stack of rows line up: the divider starts at the text. */
  const dividerInset = hasLeading ? badgeSize + gap : 0;

  const description =
    accessibilityLabel ?? [title, subtitle, value, valueCaption, caption].filter(Boolean).join(', ');

  const body = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap,
          paddingVertical: padY,
          backgroundColor: selected ? t.color.primarySoft : undefined,
          borderRadius: selected ? t.radius.md : undefined,
          paddingHorizontal: selected ? t.spacing.sm : 0,
          marginHorizontal: selected ? -t.spacing.sm : 0,
          // Keeps a row with only a short title at a comfortable tap height.
          minHeight: dense ? 0 : t.minTarget,
        },
        tappable ? null : style,
      ]}
    >
      {leading ??
        (icon ? (
          <View
            style={{
              width: badgeSize,
              height: badgeSize,
              borderRadius: t.radius.md,
              backgroundColor: skin.fill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={dense ? 'sm' : 'md'} color={skin.ink} />
          </View>
        ) : null)}

      <View style={{ flex: 1, gap: t.spacing.hair }}>
        <Text
          variant={dense ? 'subheadStrong' : 'headline'}
          color={destructive ? 'danger' : 'text'}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" color="textSecondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {caption ? (
          <Text variant="caption" color="textTertiary" numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>

      {value !== undefined || valueCaption !== undefined ? (
        <View style={{ alignItems: 'flex-end', gap: t.spacing.hair, maxWidth: '45%' }}>
          {value !== undefined ? (
            <Text variant={dense ? 'subhead' : 'callout'} color={valueColor} tabular numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {valueCaption !== undefined ? (
            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {valueCaption}
            </Text>
          ) : null}
        </View>
      ) : null}

      {trailing}

      {showChevron ? <Icon name="chevron-forward" size="sm" color="textTertiary" /> : null}
    </View>
  );

  const wrapped = tappable ? (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic="tap"
      onPress={onPress}
      onLongPress={onLongPress}
      pressScale="large"
      dim
      style={style}
    >
      {body}
    </Touchable>
  ) : (
    <View accessible accessibilityRole="text" accessibilityLabel={description}>
      {body}
    </View>
  );

  if (!divider) return wrapped;

  return (
    <View>
      {wrapped}
      <View
        style={{
          marginLeft: dividerInset,
          height: t.borderWidth.hairline,
          backgroundColor: t.color.divider,
        }}
      />
    </View>
  );
}

export default ListRow;
