/**
 * The component library's single import surface.
 *
 * Screens do `import { Screen, Card, Button, Text } from '@/ui'` rather than
 * reaching into individual files. Two reasons: it keeps import blocks short in
 * screens that legitimately use a dozen components, and it means a component can
 * be split or renamed internally without editing forty call sites.
 *
 * Illustrations and skeleton compositions stay behind their own namespaces
 * (`@/ui/illustrations`, `@/ui/skeletons/ContentSkeletons`) — they're large,
 * rarely needed together, and pulling every SVG scene into every screen's module
 * graph is a real cost.
 */

/* ------------------------------------------------------------- primitives */

export { Text, resolveColor, type TextProps, type ColorToken, type ColorProp, type TextAlign } from './Text';
export { Touchable, type TouchableProps, type TouchableHaptic, type PressScaleToken } from './Touchable';
export { Icon, ICON_SIZE, type IconProps, type IconName, type IconSize } from './Icon';
export { Surface, type SurfaceProps, type SurfaceVariant } from './Surface';
export { Card, type CardProps } from './Card';
export { Stack, Row, Column, Spacer, type StackProps, type SpacerProps, type StackAlign, type StackJustify } from './Stack';
export { Divider, type DividerProps, type DividerInset } from './Divider';

/* ----------------------------------------------------------------- actions */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { IconButton, type IconButtonProps, type IconButtonVariant, type IconButtonTone, type IconButtonSize } from './IconButton';

/* ------------------------------------------------------------ indicators */

export { Badge, type BadgeProps, type BadgeTone, type BadgeSize } from './Badge';
export { Chip, type ChipProps, type ChipTone, type ChipSize } from './Chip';
export { Avatar, AVATAR_SIZE, type AvatarProps, type AvatarSize, type AvatarStatus } from './Avatar';
export { AvatarStack, type AvatarStackProps, type AvatarStackItem } from './AvatarStack';

/* -------------------------------------------------------------- structure */

export { Screen, useScreenScroll, type ScreenProps, type ScreenEdge, type ScreenScrollContextValue } from './Screen';
export { ScreenHeader, type ScreenHeaderProps } from './ScreenHeader';
export { SectionHeader, type SectionHeaderProps, type SectionHeaderVariant } from './SectionHeader';
export { ListRow, type ListRowProps, type ListRowSize, type ListRowIconTone } from './ListRow';
export { Timeline, type TimelineProps, type TimelineEntry, type TimelineTone, type TimelineState } from './Timeline';
export { SwipeRow, type SwipeRowProps, type SwipeRowHandle, type SwipeAction, type SwipeActionTone, type SwipeSide } from './SwipeRow';

/* ------------------------------------------------------------------ forms */

export { FormField, FieldFrame, FieldMessage, FieldCounter, FieldIcon, FieldSheet, FieldDialog, useFieldMetrics, useFieldShake, fieldInk, type FormFieldProps, type FieldSize, type FieldVariant } from './FormField';
/** `Animated.createAnimatedComponent(Text)` — for springing text colour between palettes. */
export { AnimatedText } from './FormField';
export { Input, type InputProps, type InputHandle } from './Input';
export { TextArea, type TextAreaProps, type TextAreaHandle } from './TextArea';
export { SearchField, type SearchFieldProps, type SearchFieldHandle } from './SearchField';
export { Select, type SelectProps, type SelectOption, type SelectSection, type SelectValue } from './Select';
export { SegmentedControl, type SegmentedControlProps, type Segment, type SegmentValue, type SegmentedControlSize } from './SegmentedControl';
export { Switch, type SwitchProps, type SwitchSize, type SwitchTone } from './Switch';
export { Checkbox, RadioButton, type CheckboxProps, type RadioButtonProps, type CheckboxSize, type CheckboxTone } from './Checkbox';
export { Stepper, type StepperProps, type StepperSize } from './Stepper';
export { Calendar, type CalendarProps, type CalendarMark, type CalendarMarks, type CalendarMarkTone, type CalendarRange } from './Calendar';
export { DateField, type DateFieldProps } from './DateField';
export { TimeField, TimeWheel, type TimeFieldProps, type TimeWheelProps, type HourCycle } from './TimeField';
export { PhotoPicker, type PhotoPickerProps, type PhotoPickerShape } from './PhotoPicker';

/* --------------------------------------------------------------- feedback */

export { Skeleton, SkeletonText, SkeletonCircle, SkeletonGroup, type SkeletonProps, type SkeletonTextProps, type SkeletonCircleProps, type SkeletonGroupProps } from './Skeleton';
export { EmptyState, type EmptyStateProps, type EmptyStateAction, type EmptyStateVariant, type EmptyStateTone } from './EmptyState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { Banner, type BannerProps, type BannerTone, type BannerEmphasis, type BannerAction } from './Banner';
export { LoadingDots, type LoadingDotsProps, type LoadingDotsSize } from './LoadingDots';
export { toast, useToast, ToastHost, ToastProvider, type ToastOptions, type ToastTone, type ToastAction, type ToastApi } from './Toast';
export { Sheet, SheetHeader, ConfirmSheet, useSheet, percentSnapPoints, SHEET_SNAP, type SheetProps, type SheetHeaderProps, type ConfirmSheetProps, type SheetController, type SheetSize } from './Sheet';
export { confetti, Confetti, ConfettiHost, type ConfettiHandle, type ConfettiOptions, type ConfettiShape } from './Confetti';
export { RefreshableScrollView, RefreshableFlatList, type RefreshableScrollViewProps, type RefreshableFlatListProps, type PullToRefreshProps } from './PullToRefresh';

/* ------------------------------------------------------------------ data */

export { ProgressRing, type ProgressRingProps, type ProgressRingSize, type ProgressRingTone } from './ProgressRing';
export { ProgressBar, type ProgressBarProps, type ProgressBarTone, type ProgressBarSize, type ProgressSegment } from './ProgressBar';
export { Sparkline, sparklinePath, type SparklineProps, type SparklinePoint } from './Sparkline';
export { LineChart, type LineChartProps, type LineChartPoint, type LineChartTarget } from './LineChart';
export { BarChart, type BarChartProps, type BarChartDatum, type BarChartTone } from './BarChart';
export { StatTile, type StatTileProps, type StatDelta, type StatDeltaTone } from './StatTile';

/* ------------------------------------------------------------------- art */

export { PawGlyph, PawPrint, PAW_VIEWBOX, type PawGlyphProps, type PawPrintProps } from './PawPrint';
