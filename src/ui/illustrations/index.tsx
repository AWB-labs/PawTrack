/**
 * Petal — illustration registry.
 *
 * Two ways in, for two different callers:
 *
 *   · **Direct import** — `<EmptyPets size={200}/>` when a screen knows exactly
 *     which scene it wants.
 *   · **By name** — `<Illustration name={state.art}/>` when the scene is chosen
 *     by data (an error mapper picking `offline` vs `generic`, a config-driven
 *     empty state). `IllustrationName` keeps that lookup exhaustive, so adding a
 *     scene here is the only edit needed.
 */

import React from 'react';

import { EmptyActivity } from './EmptyActivity';
import { EmptyAppointments } from './EmptyAppointments';
import { EmptyCaregivers } from './EmptyCaregivers';
import { EmptyComments } from './EmptyComments';
import { EmptyDocuments } from './EmptyDocuments';
import { EmptyFeed } from './EmptyFeed';
import { EmptyFeeding } from './EmptyFeeding';
import { EmptyMedicine } from './EmptyMedicine';
import { EmptyPets } from './EmptyPets';
import { EmptySearch } from './EmptySearch';
import { EmptyVaccinations } from './EmptyVaccinations';
import { ErrorGeneric } from './ErrorGeneric';
import { ErrorNotFound } from './ErrorNotFound';
import { ErrorOffline } from './ErrorOffline';
import { InviteScan } from './InviteScan';
import { PermissionLocked } from './PermissionLocked';
import { SuccessCheck } from './SuccessCheck';
import { WelcomePets } from './WelcomePets';
import type { IllustrationProps } from './base';

/* ----------------------------------------------------------------- exports */

export {
  DEFAULT_ILLUSTRATION_SIZE,
  Ground,
  IllustrationFrame,
  Sparkle,
  useIllustrationPalette,
  type IllustrationPalette,
  type IllustrationProps,
} from './base';

export {
  EmptyActivity,
  EmptyAppointments,
  EmptyCaregivers,
  EmptyComments,
  EmptyDocuments,
  EmptyFeed,
  EmptyFeeding,
  EmptyMedicine,
  EmptyPets,
  EmptySearch,
  EmptyVaccinations,
  ErrorGeneric,
  ErrorNotFound,
  ErrorOffline,
  InviteScan,
  PermissionLocked,
  SuccessCheck,
  WelcomePets,
};

/* ---------------------------------------------------------------- registry */

export const ILLUSTRATIONS = {
  emptyPets: EmptyPets,
  emptyVaccinations: EmptyVaccinations,
  emptyFeeding: EmptyFeeding,
  emptyMedicine: EmptyMedicine,
  emptyAppointments: EmptyAppointments,
  emptyDocuments: EmptyDocuments,
  emptyCaregivers: EmptyCaregivers,
  emptyActivity: EmptyActivity,
  emptyFeed: EmptyFeed,
  emptyComments: EmptyComments,
  emptySearch: EmptySearch,
  errorGeneric: ErrorGeneric,
  errorOffline: ErrorOffline,
  errorNotFound: ErrorNotFound,
  permissionLocked: PermissionLocked,
  successCheck: SuccessCheck,
  welcomePets: WelcomePets,
  inviteScan: InviteScan,
} as const satisfies Record<string, React.ComponentType<IllustrationProps>>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;

export const ILLUSTRATION_NAMES = Object.keys(ILLUSTRATIONS) as IllustrationName[];

export type IllustrationByNameProps = IllustrationProps & { name: IllustrationName };

export function Illustration({ name, ...rest }: IllustrationByNameProps) {
  const Scene = ILLUSTRATIONS[name];
  return <Scene {...rest} />;
}

export default Illustration;
