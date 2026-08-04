/**
 * Petal — display formatting.
 *
 * Everything here turns stored data into something a person reads. Two rules
 * the whole module follows:
 *
 *  1. **Storage units never leak.** Weight is kilograms in the database,
 *     always; the `lb` in the UI is a *rendering* of that number, produced
 *     here. Screens pass kilograms and get a string — they never do the
 *     conversion themselves, which is how a 6kg Great Dane happens.
 *  2. **Numbers get the same care as words.** Fractional cups render as ½ not
 *     0.5, thousands round to "1.2k", and "1 doses" is a bug. Sloppy numerals
 *     make an app feel machine-generated faster than almost anything else.
 */

import type { PortionUnit } from '@/data/types';
import { getPreferences, type WeightUnit } from '@/stores/preferences';

/* ----------------------------------------------------------------- weight */

const LB_PER_KG = 2.2046226218;

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}

export type WeightFormatOptions = {
  /** Override the user's preference — used by the unit picker's own preview. */
  unit?: WeightUnit;
  /** Defaults to 1 for kg, 1 for lb; 2 for values under 1 so kittens read sensibly. */
  decimals?: number;
  /** Set false for a bare numeral next to a separate unit label. */
  withUnit?: boolean;
};

/** The user's chosen display unit, read non-reactively. */
export function displayWeightUnit(override?: WeightUnit): WeightUnit {
  return override ?? getPreferences().weightUnit;
}

/** Kilograms → the number shown in the field the user types into. */
export function toDisplayWeight(kg: number, override?: WeightUnit): number {
  return displayWeightUnit(override) === 'lb' ? kgToLb(kg) : kg;
}

/** The inverse — take what they typed and store kilograms. */
export function fromDisplayWeight(value: number, override?: WeightUnit): number {
  return displayWeightUnit(override) === 'lb' ? lbToKg(value) : value;
}

export function weightUnitLabel(override?: WeightUnit): string {
  return displayWeightUnit(override);
}

/** `4.25` → `"4.3 kg"` or `"9.4 lb"`. */
export function formatWeight(kg: number, options: WeightFormatOptions = {}): string {
  if (!Number.isFinite(kg)) return '—';
  const unit = displayWeightUnit(options.unit);
  const value = unit === 'lb' ? kgToLb(kg) : kg;
  // Small pets live in the decimals — a 340g hamster must not render as "0.3".
  const decimals = options.decimals ?? (Math.abs(value) < 1 ? 2 : 1);
  const numeral = trimZeros(value.toFixed(decimals));
  return options.withUnit === false ? numeral : `${numeral} ${unit}`;
}

/** Signed change between two weigh-ins. Uses a real minus sign, not a hyphen. */
export function formatWeightDelta(deltaKg: number, options: WeightFormatOptions = {}): string {
  if (!Number.isFinite(deltaKg) || Math.abs(deltaKg) < 0.005) return 'No change';
  const unit = displayWeightUnit(options.unit);
  const value = unit === 'lb' ? kgToLb(deltaKg) : deltaKg;
  const decimals = options.decimals ?? (Math.abs(value) < 1 ? 2 : 1);
  const numeral = trimZeros(Math.abs(value).toFixed(decimals));
  return `${value > 0 ? '+' : '−'}${numeral} ${unit}`;
}

function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/* ---------------------------------------------------------------- portion */

/** Quarter-step fractions, because "0.5 cup" is a recipe nobody writes. */
const FRACTIONS: Record<string, string> = {
  '0.25': '¼',
  '0.5': '½',
  '0.75': '¾',
  '0.33': '⅓',
  '0.67': '⅔',
};

const PORTION_UNITS: Record<PortionUnit, { one: string; many: string; spaced: boolean }> = {
  g: { one: 'g', many: 'g', spaced: true },
  ml: { one: 'ml', many: 'ml', spaced: true },
  cup: { one: 'cup', many: 'cups', spaced: true },
  scoop: { one: 'scoop', many: 'scoops', spaced: true },
  can: { one: 'can', many: 'cans', spaced: true },
  piece: { one: 'piece', many: 'pieces', spaced: true },
};

/** `1.5, 'cup'` → `"1½ cups"`. `120, 'g'` → `"120 g"`. */
export function formatPortion(portion: number, unit: PortionUnit): string {
  if (!Number.isFinite(portion)) return '—';
  const meta = PORTION_UNITS[unit];
  const numeral = formatFraction(portion);
  return meta.spaced
    ? `${numeral} ${portionUnitLabel(unit, portion)}`
    : `${numeral}${portionUnitLabel(unit, portion)}`;
}

/** A part of one stays singular — "¼ cup", never "¼ cups". */
export function portionUnitLabel(unit: PortionUnit, count = 1): string {
  const size = Math.abs(count);
  const meta = PORTION_UNITS[unit];
  return size === 1 || (size > 0 && size < 1) ? meta.one : meta.many;
}

/** `1.5` → `"1½"`, `0.25` → `"¼"`, `120` → `"120"`. */
export function formatFraction(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const whole = Math.trunc(value);
  const remainder = Math.abs(value - whole);
  const glyph = FRACTIONS[trimZeros(remainder.toFixed(2))];
  if (!glyph) return trimZeros(value.toFixed(2));
  if (whole === 0) return value < 0 ? `−${glyph}` : glyph;
  return `${whole}${glyph}`;
}

/* --------------------------------------------------------------- currency */

/** Currencies whose "minor unit" isn't 1/100. Getting these wrong is a 100× bug. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyDecimals(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export type CurrencyFormatOptions = {
  /** Hide `.00` on whole amounts — right for list rows, wrong for invoices. */
  compactZeros?: boolean;
  locale?: string;
};

/**
 * Minor units in, human money out. `4250, 'GBP'` → `"£42.50"`.
 * Hermes ships full ICU, but a locale it can't resolve must degrade to a
 * readable string rather than throwing inside a render.
 */
export function formatCurrency(
  minor: number | null | undefined,
  currency: string,
  options: CurrencyFormatOptions = {},
): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
  const code = currency.toUpperCase();
  const decimals = currencyDecimals(code);
  const major = minor / 10 ** decimals;
  const fractionDigits = options.compactZeros && Number.isInteger(major) ? 0 : decimals;

  try {
    return new Intl.NumberFormat(options.locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(major);
  } catch {
    return `${major.toFixed(fractionDigits)} ${code}`;
  }
}

/* -------------------------------------------------------------- numerals */

/** `0.86` → `"86%"`. Takes a 0–1 ratio, not a pre-multiplied number. */
export function formatPercent(ratio: number, decimals = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${(clamped * 100).toFixed(decimals)}%`;
}

/** `1240` → `"1.2k"`. Community counts only — never medical figures. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trimZeros((value / 1000).toFixed(1))}k`;
  return `${trimZeros((value / 1_000_000).toFixed(1))}m`;
}

/** `2, 'dose'` → `"2 doses"`. Irregulars get an explicit plural. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${pluralWord(count, singular, pluralForm)}`;
}

/** Just the noun, for when the number is styled separately. */
export function pluralWord(count: number, singular: string, pluralForm?: string): string {
  if (Math.abs(count) === 1) return singular;
  return pluralForm ?? `${singular}s`;
}

/** `"Buddy"` → `"Buddy's"`, `"Chris"` → `"Chris'"`. The copy bank leans on this. */
export function possessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

/** `["Mon","Wed","Fri"]` → `"Mon, Wed & Fri"`. */
export function joinWithAnd(items: readonly string[], conjunction = '&'): string {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} ${conjunction} ${clean[clean.length - 1]}`;
}

/* --------------------------------------------------------------- strings */

/**
 * `"Priya Raman"` → `"PR"`. Iterates code points so an emoji or accented name
 * doesn't come back as half a surrogate pair.
 */
export function initials(name: string, max = 2): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).find((ch) => /\p{L}|\p{N}/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));

  if (words.length === 0) return '?';
  if (words.length === 1) {
    const letters = Array.from(name.trim()).filter((ch) => /\p{L}|\p{N}/u.test(ch));
    return letters.slice(0, max).join('').toUpperCase();
  }
  return [words[0], words[words.length - 1]].slice(0, max).join('').toUpperCase();
}

/** Trims on a word boundary and uses a real ellipsis. */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Decimal units, matching what iOS and Android both show in file browsers. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${trimZeros(value.toFixed(value < 10 ? 1 : 0))} ${units[index]}`;
}

/**
 * Best-effort presentational grouping for a clinic's phone number.
 *
 * Deliberately *not* a parser: we never rewrite the number we dial with, only
 * how it's displayed, and anything we don't recognise comes back untouched
 * rather than mangled into a wrong shape.
 */
export function formatPhone(raw: string): string {
  const input = raw.trim();
  if (!input) return input;

  const international = input.startsWith('+');
  const digits = input.replace(/\D/g, '');
  if (digits.length < 7) return input;

  if (international) {
    // NANP is the one country code with a universally recognised grouping.
    if (digits.startsWith('1') && digits.length === 11) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    const cc = digits.slice(0, guessCountryCodeLength(digits));
    const rest = digits.slice(cc.length);
    return `+${cc} ${chunk(rest)}`;
  }

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return input;
}

/** Single-digit codes are the NANP + Russia; 7 of the rest are two digits. */
function guessCountryCodeLength(digits: string): number {
  const first = digits[0];
  if (first === '1' || first === '7') return 1;
  const twoDigit = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);
  return twoDigit.has(digits.slice(0, 2)) ? 2 : 3;
}

function chunk(digits: string): string {
  const groups: string[] = [];
  let index = 0;
  while (index < digits.length) {
    const size = digits.length - index === 4 ? 4 : 3;
    groups.push(digits.slice(index, index + size));
    index += size;
  }
  return groups.join(' ');
}
