# Moderation runbook

App Store Guideline 1.2 requires five things of an app with a public feed. Four
are shipped in the app and the database; the fifth is a promise a person has to
keep, and this is how.

| Requirement | Where it lives |
| --- | --- |
| Agreement (EULA) with a zero-tolerance clause, before registering or signing in | `app/(auth)/agreement.tsx` (pre-auth), `app/(legal)/accept-terms.tsx` (gate), `src/features/legal/agreement.ts`, [terms.html](terms.html) §5 |
| A method of filtering objectionable content | `src/lib/moderation.ts` (client), `petal_blocked_term()` + `posts_moderate` / `comments_moderate` triggers (server) |
| A mechanism to flag objectionable content | `src/features/community/SafetySheets.tsx` → `content_reports` |
| A mechanism to block abusive users | Same sheet → `user_blocks`, plus a `content_reports` row so we are told |
| **Acting within 24 hours** | **This document** |

Everything below assumes the Supabase SQL editor (or `psql`) with the service
role. None of it is reachable from the app — the queue view and the two action
functions are revoked from `anon` and `authenticated` in `0008_moderation.sql`.

---

## Setup, once

Apply the migration to the live project:

```bash
supabase db push
```

Then confirm the boundary is actually on. Each of these should return one row:

```sql
select tablename from pg_tables
 where schemaname = 'public' and tablename in ('content_reports', 'user_blocks', 'moderation_terms');

select proname from pg_proc where proname = 'petal_eject_user';
```

And confirm the filter refuses something it should. This must raise, not insert:

```sql
select public.petal_blocked_term('you are a n1gger');   -- returns the matched row
select public.petal_blocked_term('walking in Scunthorpe'); -- returns nulls
```

## The daily job

**Once every 24 hours, without exception.** More often is better; the published
commitment is the ceiling, not the target.

### 1. Open the queue

```sql
select id, hours_open, reason, target_kind, author_name, report_count, content, details
  from public.moderation_queue;
```

Oldest first, `hours_open` first. Anything above 20 is about to breach.

`hidden_at` tells you whether the content is already down. Severe categories
(`hate`, `sexual`, `violence`, `animalCruelty`, `selfHarm`) hide on the first
report; everything else hides on the second from a different person. Either way
the reporter stopped seeing it the moment they reported it.

### 2. Decide

Read `content` (the snapshot taken when it was reported — it survives a
take-down) and `details` (the reporter's own words, usually the useful part).
Judge it against [§5.1 of the Terms](terms.html#community).

### 3a. It breaks the rules → remove and eject

One call does all of it: suspends the account, hides every post and comment it
ever made, and closes every open report against it.

```sql
select public.petal_eject_user('<author_id>', 'Hate speech — zero tolerance, Terms §5.1');
```

The suspended account can still sign in and read its own records — this is a
pet-health app and its owner's vaccination history is not ours to take away —
but `petal_is_suspended()` blocks every write to the feed.

### 3b. It doesn't → restore and dismiss

```sql
select public.petal_restore_content('post', '<target_id>', 'Reviewed — no violation');
```

### 4. Close anything left

For a report where the content was already handled under another report:

```sql
update public.content_reports
   set status = 'dismissed', resolution = 'Duplicate', resolved_at = now()
 where id = '<report_id>';
```

The reporter sees the outcome as a status chip in **Settings → Safety**.

## Checking we kept the promise

Run this weekly. It should return nothing.

```sql
select id, reason, target_kind, hours_open
  from public.moderation_queue
 where hours_open > 24;
```

And, for the record of what was actually done:

```sql
select date_trunc('day', created_at) as day,
       count(*)                                              as filed,
       count(*) filter (where status = 'actioned')            as actioned,
       count(*) filter (where status = 'open')                as still_open,
       round(avg(extract(epoch from (resolved_at - created_at)) / 3600.0), 1) as avg_hours
  from public.content_reports
 group by 1 order by 1 desc limit 30;
```

## Extending the filter

New evasion turns up. Add the term — no build, no release:

```sql
insert into public.moderation_terms (term, category, severity)
values ('<folded lowercase term>', 'hate', 'block');
```

Terms must already be folded: lowercase, letters and single spaces only. The
function applies leetspeak substitution, letter-run squashing and separator
stripping to the *input*, so `nigger` alone catches `n1gger`, `niiiigger` and
`n.i.g.g.e.r`. It does not catch a term you haven't added.

Keep `src/lib/moderation.ts` roughly in step. The database is the boundary; the
client copy is what gives the person a specific sentence instead of a generic
rejection, and a term in one and not the other is a worse experience rather than
a hole.

## Reversing a mistake

Un-suspending is a plain update — deliberately not a function, so it cannot be
done casually or by anything but a human at a keyboard:

```sql
update public.profiles set suspended_at = null, suspended_reason = null where id = '<user_id>';
update public.posts    set hidden_at = null, hidden_reason = null where author_id = '<user_id>';
update public.comments set hidden_at = null, hidden_reason = null where author_id = '<user_id>';
```

## When the terms change

Bump `TERMS_VERSION` in `src/features/legal/agreement.ts` and update
[terms.html](terms.html) and [community-guidelines.html](community-guidelines.html)
in the same change. Every account whose `profiles.terms_version` is behind the
new number meets the agreement gate on next launch, and cannot post until it
agrees. That is the whole mechanism — there is no second flag to set.
