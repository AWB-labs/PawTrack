/**
 * Pet scope — the context every screen under `pet/[petId]/` reads.
 *
 * Resolving the pet *and* the viewer's membership once, at the stack root, does
 * three things a per-screen lookup can't:
 *
 *  1. **One consistent answer.** Ten screens asking "am I the owner here?"
 *     independently is ten chances to disagree. They all read this.
 *  2. **A single place for the not-found / no-access branch.** If access was
 *     revoked while the user was inside the stack, every child screen would
 *     otherwise have to handle a suddenly-null pet.
 *  3. **Cheap capability checks.** The membership is already in hand, so
 *     `usePermission` inside this subtree is a pure function call, not a lookup.
 */

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';

import { usePet } from '@/data/queries/usePets';
import {
  effectiveCapabilities,
  windowState,
  type Capability,
  type Membership,
  type MembershipRole,
  type WindowState,
} from '@/rbac/permissions';
import { useSession } from '@/stores/session';
import type { Pet } from '@/data/types';

export type PetScope = {
  petId: string;
  pet: Pet | null;
  isLoading: boolean;
  error: unknown;
  membership: Membership | null;
  role: MembershipRole | null;
  isOwner: boolean;
  isCaregiver: boolean;
  /** Where the viewer sits in their access window — drives the sitting banner. */
  window: WindowState | null;
  capabilities: Set<Capability>;
  /** True when the record loaded but this user has no membership for it. */
  isForbidden: boolean;
};

const Ctx = createContext<PetScope | null>(null);

export function PetScopeProvider({ petId, children }: { petId: string; children: ReactNode }) {
  const memberships = useSession((s) => s.memberships);
  const { data: pet, isLoading, error } = usePet(petId);

  const value = useMemo<PetScope>(() => {
    const membership = memberships.find((m) => m.petId === petId) ?? null;
    const role = membership?.role ?? null;
    const caps = new Set(effectiveCapabilities(membership));

    return {
      petId,
      pet: pet ?? null,
      isLoading,
      error,
      membership,
      role,
      isOwner: role === 'owner',
      isCaregiver: role === 'caregiver',
      window: membership ? windowState(membership) : null,
      capabilities: caps,
      isForbidden: !isLoading && !membership,
    };
  }, [petId, memberships, pet, isLoading, error]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePetScope(): PetScope {
  const scope = useContext(Ctx);
  if (!scope) {
    throw new Error('usePetScope() must be used inside a <PetScopeProvider> (app/pet/[petId]/).');
  }
  return scope;
}

/**
 * Scope-local capability check. Falls back to the global `usePermission` hook's
 * semantics but avoids re-resolving the membership.
 */
export function useScopedCan(capability: Capability): boolean {
  return usePetScope().capabilities.has(capability);
}

export default PetScopeProvider;
