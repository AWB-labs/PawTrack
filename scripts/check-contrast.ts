/**
 * Runs the palette contrast audit outside the app.
 *
 * The same audit runs on boot in __DEV__ and logs to Metro, but that only helps
 * someone who happens to be looking. This makes it a command you can put in CI:
 *
 *   npm run check:contrast
 *
 * Exits non-zero on any WCAG AA failure.
 */

import { auditPalette, contrastRatio } from '../src/theme/contrast';
import { darkPalette, lightPalette } from '../src/theme/palette';

const findings = [...auditPalette(lightPalette), ...auditPalette(darkPalette)];

const report = (label: string, fg: string, bg: string, min: number) => {
  const ratio = contrastRatio(fg, bg);
  const ok = ratio >= min;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)}:1  (min ${min})  ${label}`,
  );
  return ok;
};

console.log('\nKey pairings\n' + '-'.repeat(60));
let ok = true;
for (const p of [lightPalette, darkPalette]) {
  console.log(`\n[${p.scheme}]`);
  ok = report(`${p.scheme} body text on bg`, p.text, p.bg, 4.5) && ok;
  ok = report(`${p.scheme} secondary on surface`, p.textSecondary, p.surface, 4.5) && ok;
  ok = report(`${p.scheme} tertiary on surfaceAlt`, p.textTertiary, p.surfaceAlt, 4.5) && ok;
  ok = report(`${p.scheme} onPrimary on primary`, p.onPrimary, p.primary, 4.5) && ok;
  ok = report(`${p.scheme} primaryText on bg`, p.primaryText, p.bg, 4.5) && ok;
  ok = report(`${p.scheme} onAccent on accent`, p.onAccent, p.accent, 4.5) && ok;
  ok = report(`${p.scheme} onDanger on danger`, p.onDanger, p.danger, 4.5) && ok;
  ok = report(`${p.scheme} focus ring on bg`, p.focus, p.bg, 3) && ok;
}

console.log('\nFull audit\n' + '-'.repeat(60));
if (findings.length === 0) {
  console.log('All semantic pairings pass WCAG AA.\n');
} else {
  for (const f of findings) {
    console.log(
      `FAIL  ${f.scheme}: ${f.name} — ${f.ratio}:1 (needs ${f.required}:1) [${f.fg} on ${f.bg}]`,
    );
  }
  console.log('');
}

process.exit(findings.length === 0 && ok ? 0 : 1);
