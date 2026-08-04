/**
 * Guards the one duplication in the codebase that we cannot design away.
 *
 * `src/rbac/permissions.ts` and `supabase/migrations/0001_init.sql` both encode
 * the capability model. That duplication is deliberate — the client cannot be
 * trusted, so Postgres has to know the rules independently. But it means an edit
 * to one and not the other silently widens or narrows the security boundary,
 * and nothing about that failure is visible at runtime until someone exploits it.
 *
 * So: compare them on every run.
 *
 *   npm run check:rbac
 *
 * Exits non-zero on any divergence between:
 *   · CAPABILITIES          ↔ the `capability` enum
 *   · CAREGIVER_GRANTABLE   ↔ petal_caregiver_grantable()
 *   · CAREGIVER_BASELINE    ↔ petal_caregiver_baseline()
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPABILITIES,
  CAREGIVER_BASELINE,
  CAREGIVER_GRANTABLE,
  OWNER_ONLY,
} from '../src/rbac/permissions';

const ROOT = join(__dirname, '..', '..');
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '0001_init.sql'), 'utf8');
const rls = readFileSync(join(ROOT, 'supabase', 'migrations', '0002_rls.sql'), 'utf8');

/** Pull the quoted string literals out of a named SQL block. */
function extractLiterals(source: string, startPattern: RegExp, label: string): string[] {
  const start = source.search(startPattern);
  if (start === -1) throw new Error(`Could not locate ${label} in the SQL.`);
  // Each of these blocks terminates at the statement's closing `$$;` or `);`.
  const rest = source.slice(start);
  const end = rest.search(/\$\$;|\);/);
  if (end === -1) throw new Error(`Could not find the end of ${label}.`);
  const body = rest.slice(0, end);
  return [...body.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]!);
}

type Comparison = { label: string; ts: readonly string[]; sql: string[]; ordered: boolean };

const comparisons: Comparison[] = [
  {
    label: 'CAPABILITIES ↔ capability enum',
    ts: CAPABILITIES,
    sql: extractLiterals(sql, /create type public\.capability as enum/, 'capability enum'),
    ordered: false,
  },
  {
    label: 'CAREGIVER_GRANTABLE ↔ petal_caregiver_grantable()',
    ts: CAREGIVER_GRANTABLE,
    sql: extractLiterals(
      sql,
      /create or replace function public\.petal_caregiver_grantable/,
      'petal_caregiver_grantable()',
    ),
    ordered: false,
  },
  {
    label: 'CAREGIVER_BASELINE ↔ petal_caregiver_baseline()',
    ts: CAREGIVER_BASELINE,
    sql: extractLiterals(
      sql,
      /create or replace function public\.petal_caregiver_baseline/,
      'petal_caregiver_baseline()',
    ),
    ordered: false,
  },
];

let failed = false;

console.log('\nRBAC parity: TypeScript ↔ Postgres\n' + '-'.repeat(62));

for (const c of comparisons) {
  const tsSet = new Set(c.ts);
  const sqlSet = new Set(c.sql);
  const missingInSql = [...tsSet].filter((x) => !sqlSet.has(x));
  const missingInTs = [...sqlSet].filter((x) => !tsSet.has(x));

  if (missingInSql.length === 0 && missingInTs.length === 0) {
    console.log(`PASS  ${c.label}  (${tsSet.size} capabilities)`);
    continue;
  }

  failed = true;
  console.log(`FAIL  ${c.label}`);
  if (missingInSql.length) console.log(`        in TS but not SQL: ${missingInSql.join(', ')}`);
  if (missingInTs.length) console.log(`        in SQL but not TS: ${missingInTs.join(', ')}`);
}

/*
 * The owner-only set is the security-critical half: these are the capabilities
 * that must be unreachable through a grant.
 *
 * The subtle failure this catches: `petal_has_capability(pet, 'activity.view')`
 * and `petal_is_owner(pet)` are equivalent *today* for any owner-only
 * capability, because the ceiling makes the caregiver branch unreachable. So the
 * wrong form passes every test and reads as correct. It only breaks later, when
 * someone widens the ceiling and a policy quietly changes meaning. Owner-only
 * intent has to be stated directly, so we require it.
 */

/** Strip `-- line` and block comments so prose about a capability isn't a match. */
function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const rlsCode = stripSqlComments(rls);

console.log('\nOwner-only capabilities must never be grantable\n' + '-'.repeat(62));
for (const cap of OWNER_ONLY) {
  if (CAREGIVER_GRANTABLE.includes(cap)) {
    failed = true;
    console.log(`FAIL  ${cap} appears in CAREGIVER_GRANTABLE`);
    continue;
  }
  // Match the actual call shape, not a bare mention of the string.
  const capabilityCall = new RegExp(
    String.raw`petal_has_capability\s*\([^)]*'${cap.replace('.', '\\.')}'`,
  );
  if (capabilityCall.test(rlsCode)) {
    failed = true;
    console.log(`FAIL  ${cap} gated via petal_has_capability() in RLS — must use petal_is_owner()`);
  } else {
    console.log(`PASS  ${cap}`);
  }
}

console.log('');
if (failed) {
  console.error('RBAC parity check FAILED — the client and the database disagree.\n');
  process.exit(1);
}
console.log('TypeScript and Postgres agree on the capability model.\n');
