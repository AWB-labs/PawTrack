/**
 * Care tasks — the Today screen's single stream.
 *
 * Feeding, medicine and appointments arrive already merged, ordered and
 * resolved against the clock, so this file adds only three things: a short
 * stale time (the stream ages in real time — a 7am slot becomes overdue at
 * 8:30 with nobody touching the app), previous-data retention so swiping
 * between days slides instead of blinking, and the two derived counts the
 * chrome needs.
 *
 * The mutations that *change* a task live with their domain — `useLogFeeding`,
 * `useLogDose`, `useUpdateAppointmentStatus` — and each patches this cache
 * optimistically. That keeps one owner per write and means the tick, the ring
 * and the tab badge move on the same frame.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { adapter } from '@/data';
import { STALE } from '@/data/QueryProvider';
import { queryKeys } from '@/data/queryKeys';
import type { CareTask, DateOnly, DaySummary, ID } from '@/data/types';
import { toDateOnly } from '@/lib/date';
import { useActor } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type CareTaskOptions = {
  /** Defaults to today, in the device's local calendar. */
  date?: DateOnly;
  /** Null or omitted means every pet the actor can see. */
  petId?: ID | null;
  enabled?: boolean;
};

export type DayProgress = {
  total: number;
  done: number;
  overdue: number;
  remaining: number;
  /** 0–1, for the Today ring. 1 when there was nothing to do. */
  ratio: number;
};

const today = (): DateOnly => toDateOnly(new Date());

const isOutstanding = (task: CareTask): boolean => task.state === 'due' || task.state === 'overdue';

const countOutstanding = (tasks: CareTask[]): number => tasks.filter(isOutstanding).length;

function summarise(tasks: CareTask[]): DayProgress {
  let done = 0;
  let overdue = 0;
  for (const task of tasks) {
    if (task.state === 'done' || task.state === 'skipped') done += 1;
    if (task.state === 'overdue') overdue += 1;
  }
  const total = tasks.length;
  return {
    total,
    done,
    overdue,
    remaining: total - done,
    ratio: total === 0 ? 1 : done / total,
  };
}

/* -------------------------------------------------------------------- reads */

export function useCareTasks(options: CareTaskOptions = {}) {
  const { ctx, ready } = useActor();
  const date = options.date ?? today();
  const petId = options.petId ?? null;

  return useQuery({
    queryKey: queryKeys.careTasks.forDay(date, petId),
    queryFn: () => adapter.listCareTasks(ctx, date, petId ? { petId } : undefined),
    enabled: ready && options.enabled !== false,
    staleTime: STALE.live,
    // Yesterday's list stays put while tomorrow's loads — the calendar strip
    // is a slide, not a teardown.
    placeholderData: keepPreviousData,
  });
}

/** Counts for the header ring, computed off the same cache entry. */
export function useDayProgress(options: CareTaskOptions = {}): DayProgress {
  const { ctx, ready } = useActor();
  const date = options.date ?? today();
  const petId = options.petId ?? null;

  const { data } = useQuery({
    queryKey: queryKeys.careTasks.forDay(date, petId),
    queryFn: () => adapter.listCareTasks(ctx, date, petId ? { petId } : undefined),
    enabled: ready && options.enabled !== false,
    staleTime: STALE.live,
    select: summarise,
  });

  return data ?? { total: 0, done: 0, overdue: 0, remaining: 0, ratio: 1 };
}

/**
 * The tab bar's badge: everything due or overdue today, across every pet. Zero
 * while loading rather than a flashing placeholder — a badge that appears and
 * disappears on every launch is worse than a badge that arrives a beat late.
 */
export function useOutstandingTaskCount(petId?: ID | null): number {
  const { ctx, ready } = useActor();
  const date = today();
  const scope = petId ?? null;

  const { data } = useQuery({
    queryKey: queryKeys.careTasks.forDay(date, scope),
    queryFn: () => adapter.listCareTasks(ctx, date, scope ? { petId: scope } : undefined),
    enabled: ready,
    staleTime: STALE.live,
    select: countOutstanding,
  });

  return data ?? 0;
}

/**
 * Per-day totals for the calendar strip. `from`/`to` are inclusive local dates;
 * the adapter expands each day itself, so a fortnight is one round trip.
 */
export function useDaySummaries(from: DateOnly, to: DateOnly, petId?: ID | null) {
  const { ctx, ready } = useActor();
  const scope = petId ?? null;

  return useQuery({
    queryKey: queryKeys.daySummaries.forRange(from, to, scope),
    queryFn: () => adapter.getDaySummaries(ctx, from, to, scope ? { petId: scope } : undefined),
    enabled: ready,
    staleTime: STALE.short,
    placeholderData: keepPreviousData,
  });
}

/** Lookup by date for the calendar strip's dots. */
export function useDaySummaryIndex(from: DateOnly, to: DateOnly, petId?: ID | null) {
  const { ctx, ready } = useActor();
  const scope = petId ?? null;

  const select = useCallback(
    (summaries: DaySummary[]) => new Map(summaries.map((summary) => [summary.date, summary])),
    [],
  );

  return useQuery({
    queryKey: queryKeys.daySummaries.forRange(from, to, scope),
    queryFn: () => adapter.getDaySummaries(ctx, from, to, scope ? { petId: scope } : undefined),
    enabled: ready,
    staleTime: STALE.short,
    select,
  });
}
