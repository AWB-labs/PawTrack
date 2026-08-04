/**
 * Petal — AvatarStack.
 *
 * Overlapping faces plus a `+N`. Used for "who can look after Buddy", so two
 * details are worth the extra code:
 *
 *   · **The stack layers back to front.** Later avatars sit *under* earlier
 *     ones, so the first face — the owner — is never clipped. Reversing the
 *     paint order is cheaper and more reliable than reordering the array.
 *   · **Each face carries a cut-out ring** in the host surface colour, which is
 *     what separates two dark avatars that overlap. Without it the stack turns
 *     into one blob at `xs`.
 *
 * The whole stack is a single accessibility element: "Buddy's caregivers, Priya,
 * Sam and 3 more" is one useful announcement where five is five swipes.
 */

import React, { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { joinWithAnd } from '@/lib/format';
import { useTheme, type SpeciesKey } from '@/theme';
import { Avatar, AVATAR_SIZE, type AvatarSize } from './Avatar';
import { resolveColor, Text, type ColorProp } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type AvatarStackItem = {
  id: string;
  name: string;
  uri?: string | null;
  species?: SpeciesKey;
  /** Ring this one — e.g. the caregiver currently on duty. */
  ring?: boolean;
};

export type AvatarStackProps = {
  items: AvatarStackItem[];
  /** Faces shown before the overflow chip. Defaults to 4. */
  max?: number;
  size?: AvatarSize | number;
  /** Fraction of the avatar width each face hides. 0 = no overlap. */
  overlap?: number;
  /** The surface behind the stack — drives the cut-out ring. */
  surfaceColor?: ColorProp;
  /** Prefix for the announcement: "Buddy's caregivers". */
  label?: string;
  onPress?: () => void;
  /** Skips the entrance stagger — for stacks inside an already-animating card. */
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

const DEFAULT_MAX = 4;
const DEFAULT_OVERLAP = 0.34;
/** Past this the stagger stops reading as a cascade and starts reading as lag. */
const MAX_STAGGERED = 6;

/* ---------------------------------------------------------------- component */

export function AvatarStack({
  items,
  max = DEFAULT_MAX,
  size = 'sm',
  overlap = DEFAULT_OVERLAP,
  surfaceColor = 'surface',
  label,
  onPress,
  animate = true,
  style,
  testID,
}: AvatarStackProps) {
  const t = useTheme();
  const px = typeof size === 'number' ? size : AVATAR_SIZE[size];

  const cut = t.borderWidth.thick;
  const ring = resolveColor(t.color, surfaceColor, t.color.surface);
  const box = px + cut * 2;
  const step = Math.round(box * (1 - overlap));

  const shown = items.slice(0, Math.max(1, max));
  const extra = items.length - shown.length;

  const description = useMemo(() => {
    if (items.length === 0) return label ?? 'No one yet';
    const names = shown.map((item) => item.name);
    const tail = extra > 0 ? [`${extra} more`] : [];
    const list = joinWithAnd([...names, ...tail], 'and');
    return label ? `${label}: ${list}` : list;
  }, [extra, items.length, label, shown]);

  const reduce = t.reduceMotion;

  const content = (
    <View style={[{ flexDirection: 'row', alignItems: 'center' }, onPress ? null : style]} testID={testID}>
      {shown.map((item, index) => (
        <Animated.View
          key={item.id}
          entering={
            !animate
              ? undefined
              : reduce
                ? FadeIn.duration(t.motion.duration.base).delay(
                    Math.min(index, MAX_STAGGERED) * t.motion.stagger.tight,
                  )
                : ZoomIn.springify()
                    .damping(t.motion.spring.gentle.damping)
                    .stiffness(t.motion.spring.gentle.stiffness)
                    .delay(Math.min(index, MAX_STAGGERED) * t.motion.stagger.tight)
          }
          style={{
            marginLeft: index === 0 ? 0 : step - box,
            // Earlier faces paint on top: the owner is never the clipped one.
            zIndex: shown.length - index,
            borderRadius: box,
            borderWidth: cut,
            borderColor: ring,
            backgroundColor: ring,
          }}
        >
          <Avatar
            uri={item.uri}
            name={item.name}
            species={item.species}
            size={px}
            ring={item.ring}
            surfaceColor={surfaceColor}
          />
        </Animated.View>
      ))}

      {extra > 0 ? (
        <View
          style={{
            marginLeft: step - box,
            width: box,
            height: box,
            borderRadius: box,
            borderWidth: cut,
            borderColor: ring,
            backgroundColor: t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 0,
          }}
        >
          <Text
            variant="caption"
            color="textSecondary"
            tabular
            maxFontSizeMultiplier={1.2}
            importantForAccessibility="no-hide-descendants"
          >
            {`+${extra}`}
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={description}>
        {content}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityHint="Opens the full list"
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={style}
    >
      {content}
    </Touchable>
  );
}

export default AvatarStack;
