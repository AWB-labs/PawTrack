/**
 * Petal — content skeletons.
 *
 * A skeleton is only worth having if it lands where the real thing lands. A
 * generic grey rectangle still causes the layout jolt it was meant to prevent,
 * so every shape here is measured against the component it stands in for: same
 * padding token, same radius, same avatar diameter, same line box.
 *
 * They all take `count`, which is the common case — a list loading four rows —
 * and wraps the repeats in a `<SkeletonGroup>` so the sweep ripples down the
 * list rather than pulsing as one slab.
 *
 * When you compose these with other skeletons on a screen, wrap the whole
 * screen in a single `<SkeletonGroup>`: nested groups inherit the parent's
 * clock, so the ripple stays continuous across sections.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '@/theme';
import { Skeleton, SkeletonCircle, SkeletonGroup, SkeletonText } from '../Skeleton';
import type { SpacingToken } from '../Stack';
import { Surface } from '../Surface';

/* -------------------------------------------------------------------- types */

type BaseProps = {
  /** Repeats the shape, rippling the sweep across the copies. */
  count?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type PetCardSkeletonProps = BaseProps;
export type TaskRowSkeletonProps = BaseProps;
export type ListRowSkeletonProps = BaseProps & { avatar?: boolean };
export type CaregiverRowSkeletonProps = BaseProps;
export type PostSkeletonProps = BaseProps & { image?: boolean };
export type TimelineSkeletonProps = { items?: number; style?: StyleProp<ViewStyle>; testID?: string };
export type ChartSkeletonProps = { bars?: number; style?: StyleProp<ViewStyle>; testID?: string };
export type ProfileHeaderSkeletonProps = { style?: StyleProp<ViewStyle>; testID?: string };

/* ------------------------------------------------------------------ helpers */

/** Diameters that match the real components, expressed against the grid. */
function metrics(t: Theme) {
  return {
    /** Pet card portrait. */
    portrait: t.spacing.huge + t.spacing.sm, // 56
    /** Post / list avatar. */
    avatar: t.spacing.xxxl, // 40
    /** Caregiver avatar — one tap target across. */
    caregiver: t.minTarget, // 44
    /** Profile hero portrait. */
    hero: t.spacing.huge + t.spacing.xxxl, // 88
    /** Round icon well inside a task row. */
    well: t.spacing.xxxl, // 40
    /** Trailing tick control. */
    tick: t.spacing.xxl, // 32
    /** Chart plot height. */
    plot: t.spacing.colossal + t.spacing.huge, // 128
  };
}

function Repeat({
  count,
  gap,
  render,
}: {
  count: number;
  gap: SpacingToken;
  render: (index: number) => ReactNode;
}) {
  if (count <= 1) return <>{render(0)}</>;
  return (
    <SkeletonGroup gap={gap}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index}>{render(index)}</View>
      ))}
    </SkeletonGroup>
  );
}

/* --------------------------------------------------------------- pet card */

/** Mirrors `<Card accent padding="base" radius="xl">` with a portrait + chips. */
export function PetCardSkeleton({ count = 1, style, testID }: PetCardSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <Repeat
      count={count}
      gap="md"
      render={(index) => (
        <Surface
          elevation={1}
          radius="xl"
          padding="none"
          testID={index === 0 ? testID : undefined}
          style={[styles.clipRow, style]}
        >
          {/*
            The identity bar every pet card carries. A plain stretched view
            rather than a Skeleton: a 4pt strip can't show a sweep, and a
            percentage height inside an auto-height row resolves to nothing.
          */}
          <View style={{ width: t.spacing.xxs, alignSelf: 'stretch', backgroundColor: t.color.skeleton }} />
          <View style={{ flex: 1, padding: t.spacing.base, gap: t.spacing.md }}>
            <View style={[styles.row, { gap: t.spacing.md }]}>
              <SkeletonCircle size={m.portrait} />
              <View style={{ flex: 1, gap: t.spacing.xs }}>
                <Skeleton w="52%" h={t.type.title3.fontSize} r="xs" />
                <Skeleton w="72%" h={t.type.footnote.fontSize} r="xs" dim />
              </View>
              <Skeleton w={t.spacing.md} h={t.spacing.lg} r="xs" dim />
            </View>
            <View style={[styles.row, { gap: t.spacing.sm }]}>
              <Skeleton w={t.spacing.colossal} h={t.spacing.xl} r="pill" dim />
              <Skeleton w={t.spacing.giant} h={t.spacing.xl} r="pill" dim />
            </View>
          </View>
        </Surface>
      )}
    />
  );
}

/* --------------------------------------------------------------- task row */

/** Mirrors a Today row: time gutter, icon well, two lines, tick control. */
export function TaskRowSkeleton({ count = 1, style, testID }: TaskRowSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <Repeat
      count={count}
      gap="sm"
      render={(index) => (
        <View
          style={[styles.row, { gap: t.spacing.md }, style]}
          testID={index === 0 ? testID : undefined}
        >
          <View style={{ width: t.spacing.huge, gap: t.spacing.hair }}>
            <Skeleton w="86%" h={t.type.subheadStrong.fontSize} r="xs" />
            <Skeleton w="60%" h={t.type.caption.fontSize} r="xs" dim />
          </View>
          <Surface
            variant="surface"
            elevation={0}
            radius="lg"
            padding="md"
            border
            style={[styles.row, styles.grow, { gap: t.spacing.md }]}
          >
            <SkeletonCircle size={m.well} />
            <View style={{ flex: 1, gap: t.spacing.xs }}>
              <Skeleton w="64%" h={t.type.headline.fontSize} r="xs" />
              <Skeleton w="44%" h={t.type.footnote.fontSize} r="xs" dim />
            </View>
            <SkeletonCircle size={m.tick} />
          </Surface>
        </View>
      )}
    />
  );
}

/* --------------------------------------------------------------- timeline */

/** Rail + node + card, matching the activity and vet-history timelines. */
export function TimelineSkeleton({ items = 4, style, testID }: TimelineSkeletonProps) {
  const t = useTheme();
  const node = t.spacing.md;

  return (
    <SkeletonGroup style={style} testID={testID}>
      {Array.from({ length: items }, (_, index) => {
        const last = index === items - 1;
        return (
          <View key={index} style={[styles.row, styles.alignStart, { gap: t.spacing.md }]}>
            <View style={[styles.rail, { width: t.spacing.lg }]}>
              <SkeletonCircle size={node} />
              {last ? null : (
                <View
                  style={{
                    flex: 1,
                    width: t.borderWidth.thin,
                    marginTop: t.spacing.xxs,
                    backgroundColor: t.color.divider,
                  }}
                />
              )}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : t.spacing.lg, gap: t.spacing.xs }}>
              <Skeleton w="38%" h={t.type.caption.fontSize} r="xs" dim />
              <Surface variant="surfaceAlt" radius="lg" padding="md" style={{ gap: t.spacing.sm }}>
                <Skeleton w="70%" h={t.type.bodyStrong.fontSize} r="xs" />
                <Skeleton w="48%" h={t.type.footnote.fontSize} r="xs" dim />
              </Surface>
            </View>
          </View>
        );
      })}
    </SkeletonGroup>
  );
}

/* ------------------------------------------------------------------- post */

/** Community post: author row, body copy, optional photo, three actions. */
export function PostSkeleton({ count = 1, image = true, style, testID }: PostSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <Repeat
      count={count}
      gap="base"
      render={(index) => (
        <Surface
          elevation={1}
          radius="xl"
          padding="base"
          testID={index === 0 ? testID : undefined}
          style={[{ gap: t.spacing.md }, style]}
        >
          <View style={[styles.row, { gap: t.spacing.sm }]}>
            <SkeletonCircle size={m.avatar} />
            <View style={{ flex: 1, gap: t.spacing.hair }}>
              <Skeleton w="42%" h={t.type.subheadStrong.fontSize} r="xs" />
              <Skeleton w="28%" h={t.type.caption.fontSize} r="xs" dim />
            </View>
            <Skeleton w={t.spacing.base} h={t.spacing.base} r="xs" dim />
          </View>

          <SkeletonText lines={3} variant="callout" lastLineWidth={0.55} />

          {image ? (
            // The box owns the 16:10 crop; the skeleton fills it absolutely so
            // its size never depends on a percentage resolving.
            <View style={styles.photo}>
              <Skeleton w="100%" h="100%" r="lg" style={StyleSheet.absoluteFill} />
            </View>
          ) : null}

          <View style={[styles.row, { gap: t.spacing.xl }]}>
            <Skeleton w={t.spacing.huge} h={t.spacing.base} r="pill" dim />
            <Skeleton w={t.spacing.huge} h={t.spacing.base} r="pill" dim />
            <Skeleton w={t.spacing.xxl} h={t.spacing.base} r="pill" dim />
          </View>
        </Surface>
      )}
    />
  );
}

/* ------------------------------------------------------------------ chart */

/** Weight / adherence card: header, plot with bars, axis labels. */
export function ChartSkeleton({ bars = 7, style, testID }: ChartSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);
  const count = Math.max(3, bars);

  return (
    <Surface elevation={1} radius="xl" padding="base" testID={testID} style={[{ gap: t.spacing.lg }, style]}>
      <View style={[styles.row, styles.between]}>
        <View style={{ gap: t.spacing.xs }}>
          <Skeleton w={t.spacing.colossal} h={t.type.caption.fontSize} r="xs" dim />
          <Skeleton w={t.spacing.colossal + t.spacing.xl} h={t.type.metricSmall.fontSize} r="xs" />
        </View>
        <Skeleton w={t.spacing.colossal} h={t.spacing.xl} r="pill" dim />
      </View>

      <View style={[styles.row, styles.alignEnd, { height: m.plot, gap: t.spacing.sm }]}>
        {Array.from({ length: count }, (_, index) => (
          // A deterministic wave rather than random heights: a chart skeleton
          // that reshuffles on every render reads as noise, not as data.
          <View key={index} style={[styles.grow, styles.column]}>
            <Skeleton
              w="100%"
              h={Math.round(m.plot * (0.34 + 0.5 * (0.5 + 0.5 * Math.sin(index * 1.1))))}
              r="sm"
            />
          </View>
        ))}
      </View>

      <View style={[styles.row, styles.between]}>
        {Array.from({ length: Math.min(count, 5) }, (_, index) => (
          <Skeleton key={index} w={t.spacing.xxl} h={t.type.caption.fontSize} r="xs" dim />
        ))}
      </View>
    </Surface>
  );
}

/* --------------------------------------------------------------- list row */

/** The plain settings / picker row: optional avatar, two lines, trailing value. */
export function ListRowSkeleton({ count = 1, avatar = true, style, testID }: ListRowSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <Repeat
      count={count}
      gap="none"
      render={(index) => (
        <View
          testID={index === 0 ? testID : undefined}
          style={[
            styles.row,
            {
              gap: t.spacing.md,
              minHeight: t.minTarget + t.spacing.md,
              paddingVertical: t.spacing.md,
            },
            style,
          ]}
        >
          {avatar ? <SkeletonCircle size={m.avatar} /> : null}
          <View style={{ flex: 1, gap: t.spacing.xs }}>
            <Skeleton w="58%" h={t.type.body.fontSize} r="xs" />
            <Skeleton w="36%" h={t.type.footnote.fontSize} r="xs" dim />
          </View>
          <Skeleton w={t.spacing.xxl} h={t.type.footnote.fontSize} r="xs" dim />
        </View>
      )}
    />
  );
}

/* --------------------------------------------------------- profile header */

/** Centred hero: portrait, name, bio, three stats. */
export function ProfileHeaderSkeleton({ style, testID }: ProfileHeaderSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <SkeletonGroup
      style={[styles.center, { gap: t.spacing.base, paddingVertical: t.spacing.lg }, style]}
      testID={testID}
    >
      <SkeletonCircle size={m.hero} />
      <View style={[styles.center, { gap: t.spacing.sm }]}>
        <Skeleton w={t.spacing.colossal + t.spacing.huge} h={t.type.title1.fontSize} r="xs" />
        <View style={{ width: '78%' }}>
          <SkeletonText lines={2} variant="footnote" lastLineWidth={0.7} dim />
        </View>
      </View>
      <View style={[styles.row, { gap: t.spacing.xl }]}>
        {Array.from({ length: 3 }, (_, index) => (
          <View key={index} style={[styles.center, { gap: t.spacing.xs }]}>
            <Skeleton w={t.spacing.xxxl} h={t.type.metricSmall.fontSize} r="xs" />
            <Skeleton w={t.spacing.huge + t.spacing.sm} h={t.type.caption.fontSize} r="xs" dim />
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}

/* ---------------------------------------------------------- caregiver row */

/** Caregiver list row: avatar, name, access pill, chevron. */
export function CaregiverRowSkeleton({ count = 1, style, testID }: CaregiverRowSkeletonProps) {
  const t = useTheme();
  const m = metrics(t);

  return (
    <Repeat
      count={count}
      gap="sm"
      render={(index) => (
        <Surface
          variant="surface"
          elevation={0}
          radius="lg"
          padding="md"
          border
          testID={index === 0 ? testID : undefined}
          style={[styles.row, { gap: t.spacing.md }, style]}
        >
          <SkeletonCircle size={m.caregiver} />
          <View style={{ flex: 1, gap: t.spacing.xs }}>
            <Skeleton w="46%" h={t.type.bodyStrong.fontSize} r="xs" />
            <Skeleton w="30%" h={t.type.caption.fontSize} r="xs" dim />
          </View>
          <Skeleton w={t.spacing.colossal} h={t.spacing.xl} r="pill" dim />
          <Skeleton w={t.spacing.sm} h={t.spacing.base} r="xs" dim />
        </Surface>
      )}
    />
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  alignStart: { alignItems: 'flex-start' },
  alignEnd: { alignItems: 'flex-end' },
  between: { justifyContent: 'space-between' },
  center: { alignItems: 'center' },
  grow: { flex: 1 },
  column: { justifyContent: 'flex-end' },
  clipRow: { overflow: 'hidden', flexDirection: 'row' },
  rail: { alignItems: 'center', alignSelf: 'stretch' },
  // A 16:10 crop is what the composer produces, so the reserve is exact.
  photo: { aspectRatio: 16 / 10 },
});

export const ContentSkeletons = {
  PetCardSkeleton,
  TaskRowSkeleton,
  TimelineSkeleton,
  PostSkeleton,
  ChartSkeleton,
  ListRowSkeleton,
  ProfileHeaderSkeleton,
  CaregiverRowSkeleton,
};

export default ContentSkeletons;
