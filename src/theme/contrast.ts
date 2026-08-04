/**
 * WCAG contrast maths + a development-time guard.
 *
 * The point of this file is that accessibility stops being a review checklist
 * item and becomes a thing that shouts in the Metro logs. `auditPalettes()`
 * runs once on boot in __DEV__ and reports any semantic pairing that has
 * drifted below its threshold.
 */

import type { Palette } from './palette';

type RGB = { r: number; g: number; b: number };

function parseColor(input: string): RGB | null {
  const value = input.trim();

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  const rgba = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i,
  );
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]) };
  }

  return null;
}

function alphaOf(input: string): number {
  const rgba = input
    .trim()
    .match(/^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+(?:[,/\s]+([\d.]+))?\s*\)$/i);
  return rgba?.[1] !== undefined ? Number(rgba[1]) : 1;
}

/** Flatten a translucent colour over an opaque backdrop. */
export function flatten(fg: string, bg: string): string {
  const a = alphaOf(fg);
  if (a >= 1) return fg;
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return fg;
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return `rgb(${mix(f.r, b.r)}, ${mix(f.g, b.g)}, ${mix(f.b, b.b)})`;
}

function channelLuminance(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG 2.1 contrast ratio, 1–21. Translucent `fg` is flattened over `bg`. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(flatten(fg, bg));
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastLevel = 'body' | 'large' | 'nonText';

/** AA thresholds: 4.5 body, 3.0 large text (≥18.66pt bold / ≥24pt), 3.0 UI. */
export const THRESHOLD: Record<ContrastLevel, number> = {
  body: 4.5,
  large: 3,
  nonText: 3,
};

export function meets(fg: string, bg: string, level: ContrastLevel = 'body'): boolean {
  return contrastRatio(fg, bg) >= THRESHOLD[level];
}

/**
 * Pick whichever of two inks reads best on `bg`. Used by dynamic surfaces
 * (species colours, user-picked pet accents) where the ground isn't known
 * at design time.
 */
export function readableInk(bg: string, dark: string, light: string): string {
  return contrastRatio(dark, bg) >= contrastRatio(light, bg) ? dark : light;
}

type Check = { name: string; fg: keyof Palette; bg: keyof Palette; level: ContrastLevel };

/**
 * Several dark-mode "soft" tokens are deliberately translucent
 * (`rgba(143,183,139,0.14)`) so a tinted chip picks up whatever surface it sits
 * on. Measuring ink against that alpha value as if it were opaque is
 * meaningless — it has to be composited over the surface underneath first.
 */
function resolveGround(palette: Palette, token: keyof Palette): string {
  const value = palette[token];
  if (typeof value !== 'string') return palette.surface;
  // Soft tokens are used on cards far more often than on the page itself, so
  // `surface` is the honest worst case to test against.
  return flatten(value, palette.surface);
}

const CHECKS: Check[] = [
  { name: 'body text on bg', fg: 'text', bg: 'bg', level: 'body' },
  { name: 'body text on surface', fg: 'text', bg: 'surface', level: 'body' },
  { name: 'secondary on bg', fg: 'textSecondary', bg: 'bg', level: 'body' },
  { name: 'secondary on surface', fg: 'textSecondary', bg: 'surface', level: 'body' },
  { name: 'tertiary on bg', fg: 'textTertiary', bg: 'bg', level: 'body' },
  { name: 'tertiary on surface', fg: 'textTertiary', bg: 'surface', level: 'body' },
  { name: 'tertiary on surfaceAlt', fg: 'textTertiary', bg: 'surfaceAlt', level: 'body' },
  { name: 'onPrimary on primary', fg: 'onPrimary', bg: 'primary', level: 'body' },
  { name: 'primaryText on bg', fg: 'primaryText', bg: 'bg', level: 'body' },
  { name: 'primaryText on surface', fg: 'primaryText', bg: 'surface', level: 'body' },
  { name: 'onPrimarySoft on primarySoft', fg: 'onPrimarySoft', bg: 'primarySoft', level: 'body' },
  { name: 'onAccent on accent', fg: 'onAccent', bg: 'accent', level: 'body' },
  { name: 'accentText on surface', fg: 'accentText', bg: 'surface', level: 'body' },
  { name: 'onAccentSoft on accentSoft', fg: 'onAccentSoft', bg: 'accentSoft', level: 'body' },
  { name: 'onDanger on danger', fg: 'onDanger', bg: 'danger', level: 'body' },
  { name: 'onDangerSoft on dangerSoft', fg: 'onDangerSoft', bg: 'dangerSoft', level: 'body' },
  { name: 'onWarning on warning', fg: 'onWarning', bg: 'warning', level: 'body' },
  { name: 'onWarningSoft on warningSoft', fg: 'onWarningSoft', bg: 'warningSoft', level: 'body' },
  { name: 'onInfo on info', fg: 'onInfo', bg: 'info', level: 'body' },
  { name: 'onInfoSoft on infoSoft', fg: 'onInfoSoft', bg: 'infoSoft', level: 'body' },
  { name: 'onSuccessSoft on successSoft', fg: 'onSuccessSoft', bg: 'successSoft', level: 'body' },
  { name: 'focus ring on bg', fg: 'focus', bg: 'bg', level: 'nonText' },
  { name: 'focus ring on surface', fg: 'focus', bg: 'surface', level: 'nonText' },
  { name: 'primary fill on bg', fg: 'primary', bg: 'bg', level: 'nonText' },
];

/*
 * Deliberately NOT checked: `border` / `borderStrong` against their surfaces.
 * WCAG 1.4.11 covers UI components whose *boundary is the only way* to perceive
 * state or extent. Petal's cards, inputs and rows all carry a background fill
 * distinct from their ground, so the hairline on top of that is decorative
 * emphasis. Holding a 1px warm hairline to 3:1 would force a hard charcoal rule
 * on cream — which would look like a wireframe and help nobody. State that
 * genuinely depends on a line (focus) is checked above, at 3:1.
 */

export type ContrastFinding = {
  scheme: string;
  name: string;
  ratio: number;
  required: number;
  fg: string;
  bg: string;
};

/** Returns every pairing that fails its threshold. Empty array == all good. */
export function auditPalette(palette: Palette): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const check of CHECKS) {
    const fg = palette[check.fg];
    if (typeof fg !== 'string' || typeof palette[check.bg] !== 'string') continue;
    const bg = resolveGround(palette, check.bg);
    const ratio = contrastRatio(fg, bg);
    const required = THRESHOLD[check.level];
    if (ratio < required) {
      findings.push({
        scheme: palette.scheme,
        name: check.name,
        ratio: Math.round(ratio * 100) / 100,
        required,
        fg,
        bg,
      });
    }
  }
  return findings;
}

let audited = false;

/** Called once from ThemeProvider in __DEV__. */
export function auditPalettesOnce(palettes: Palette[]): void {
  // `__DEV__` is injected by Metro as a global but is absent when this module is
  // compiled and run under plain Node by `npm run check:contrast`, so it has to
  // be read defensively rather than referenced directly.
  const flag = (globalThis as Record<string, unknown>).__DEV__;
  if (audited || flag !== true) return;
  audited = true;
  const findings = palettes.flatMap(auditPalette);
  if (findings.length === 0) {
    console.log('[petal/a11y] contrast audit passed for all palettes ✓');
    return;
  }
  console.warn(
    `[petal/a11y] ${findings.length} contrast failure(s):\n` +
      findings
        .map(
          (f) =>
            `  · ${f.scheme}: ${f.name} — ${f.ratio}:1 (needs ${f.required}:1) [${f.fg} on ${f.bg}]`,
        )
        .join('\n'),
  );
}
