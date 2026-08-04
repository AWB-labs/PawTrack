/**
 * New post — the composer, presented as a modal.
 *
 * Thin on purpose: `Composer` owns every decision about *writing*, this owns
 * the two things a route is actually for — where the draft came from (a group
 * page or a pet's profile can preseed it through search params) and what
 * happens when it lands.
 *
 * Posting is deliberately **not** optimistic. There are usually photos crossing
 * the network, and a post that appears in the feed and then vanishes on a failed
 * upload is a small betrayal; the composer stays put and shows its own busy
 * state instead. What *is* instant is the reward: the sheet closes, the feed
 * invalidates, and the confetti fires over it.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';

import type { CreatePostInput } from '@/data/queries/useCommunity';
import { useCreatePost, useGroups } from '@/data/queries/useCommunity';
import { Composer } from '@/features/community/Composer';
import { confetti, toast } from '@/ui';

export default function NewPostScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ groupId?: string; petId?: string }>();
  const create = useCreatePost();
  const groupsQuery = useGroups();

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
  }, [router]);

  const submit = useCallback(
    (input: CreatePostInput) => {
      create.mutate(input, {
        onSuccess: () => {
          const group = groups.find((row) => row.id === input.groupId);
          close();
          // Fired after the dismissal so it rains over the feed, not the modal.
          confetti.fire({ haptic: true });
          toast.success('Out in the world 🐾', {
            description: group
              ? `Everyone in ${group.name} can see it now.`
              : 'It’s at the top of the feed.',
          });
        },
      });
    },
    [close, create, groups],
  );

  return (
    <Composer
      initialGroupId={params.groupId ?? null}
      initialPetId={params.petId ?? null}
      submitting={create.isPending}
      onSubmit={submit}
      onCancel={close}
    />
  );
}
