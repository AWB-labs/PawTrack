-- ============================================================================
-- Petal — 0005_seed_groups.sql
-- Community groups are a curated directory — see 0002_rls.sql, there is
-- deliberately no client write path for `groups`. Without this seed a fresh
-- project shows an empty Community tab with nothing to join. Accents are drawn
-- from the Petal palette (src/theme/tokens.ts).
-- ============================================================================

insert into public.groups (name, slug, kind, description, accent) values
  ('Golden Retrievers', 'golden-retrievers', 'breed',
   'Fluff, fetch and the occasional stolen sandwich.', '#C97B1F'),
  ('Cat People',        'cat-people',        'species',
   'Nine lives, one group chat.', '#8A5CC4'),
  ('Senior Pets',       'senior-pets',       'topic',
   'Slower walks, softer beds, and the medicine schedules that come with them.', '#4F8149'),
  ('Rescue Stories',    'rescue-stories',    'topic',
   'Before-and-afters, first nights home, and the wins worth celebrating.', '#F2653A'),
  ('New Puppies',       'new-puppies',       'topic',
   'Sleep is temporary. Photos are forever.', '#2E7BC4')
on conflict (slug) do nothing;
