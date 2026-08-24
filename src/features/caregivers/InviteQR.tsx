/**
 * Petal — InviteQR.
 *
 * A real QR code, encoded here rather than pulled from a dependency, because the
 * one thing an invite has to survive is being held up in front of someone else's
 * phone across a kitchen table. A picture of a code they then have to type is
 * not that.
 *
 * The encoder below is a complete byte-mode, level-M implementation of the parts
 * of ISO/IEC 18004 an invite link needs: versions 1–10 (up to 213 bytes, where a
 * Petal link is around fifty), Reed–Solomon parity over GF(2⁸), all eight data
 * masks scored by the standard four penalty rules, and BCH-protected format and
 * version information. It runs once per code inside a `useMemo`; the whole thing
 * is a few hundred microseconds on a 29×29 matrix.
 *
 * Two presentation decisions worth defending:
 *
 *  · **The plate is light in both schemes.** A QR is a printed object, and
 *    scanners are far happier with dark modules on a light ground than with the
 *    inverse. In dark mode the plate therefore uses the *text* token and the
 *    modules use `textInverse` — an exact inversion of the pairing, so it is
 *    still entirely token-driven, and it reads as a deliberate label rather than
 *    as a theme bug.
 *  · **The Petal mark sits in a punched-out well**, five modules across (~3% of
 *    the area). Level M recovers about 15% of the codewords, so the mark costs
 *    nothing in practice while making the card unmistakably ours.
 *
 * If a payload ever exceeds version 10 the component degrades to `CodePlate` —
 * the short code set large enough to read across a room — rather than rendering
 * a matrix that cannot be scanned.
 */

import { useMemo, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';
import { Column, Icon, PawGlyph, Row, Surface, Text } from '@/ui';

/* ============================================================ encoder types */

export type QrMatrix = {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** Row-major; `true` is a dark module. */
  modules: boolean[][];
  version: number;
};

type VersionSpec = {
  /** Error-correction codewords per block. */
  ecPerBlock: number;
  /** `[blockCount, dataCodewordsPerBlock]` for each block group. */
  groups: readonly (readonly [number, number])[];
  /** Alignment-pattern centre coordinates. */
  align: readonly number[];
};

/* ================================================================ constants */

/**
 * Versions 1–10 at error-correction level M, straight from the standard's
 * error-correction characteristics table. Ten is far past what a `petal://`
 * invite link needs (213 bytes) and keeps the table readable.
 */
const VERSIONS: readonly VersionSpec[] = [
  { ecPerBlock: 10, groups: [[1, 16]], align: [] },
  { ecPerBlock: 16, groups: [[1, 28]], align: [6, 18] },
  { ecPerBlock: 26, groups: [[1, 44]], align: [6, 22] },
  { ecPerBlock: 18, groups: [[2, 32]], align: [6, 26] },
  { ecPerBlock: 24, groups: [[2, 43]], align: [6, 30] },
  { ecPerBlock: 16, groups: [[4, 27]], align: [6, 34] },
  { ecPerBlock: 18, groups: [[4, 31]], align: [6, 22, 38] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50] },
];

/** Level M's two-bit code in the format information. */
const EC_LEVEL_M = 0b00;

/** Byte mode. The invite payload is a URL, so this is the only mode we need. */
const MODE_BYTE = 0b0100;

/** Padding codewords, applied alternately once the data runs out. */
const PAD_A = 0xec;
const PAD_B = 0x11;

/** Minimum quiet zone, in modules. Below four, scanners lose the finders. */
const QUIET_ZONE = 4;

/** Width of the logo well, in modules. Odd so it centres on the grid. */
const LOGO_MODULES = 5;

/** The 1:1:3:1:1 finder lookalike penalty rule 3 hunts for. */
const FINDER_RUN: readonly boolean[] = [
  true, false, true, true, true, false, true, false, false, false, false,
];

/* ============================================================ galois field */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

for (let i = 0, x = 1; i < 255; i += 1) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  // Primitive polynomial x⁸+x⁴+x³+x²+1, the one QR is defined over.
  x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : (x << 1) & 0xff;
}
for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `count` parity symbols, highest degree first. */
function rsGenerator(count: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < count; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Synthetic long division — the parity block appended to one data block. */
function rsRemainder(data: Uint8Array, count: number): Uint8Array {
  const generator = rsGenerator(count);
  const result = new Uint8Array(count);

  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ result[0];
    for (let j = 0; j < count - 1; j += 1) result[j] = result[j + 1];
    result[count - 1] = 0;
    for (let j = 0; j < count; j += 1) result[j] ^= gfMul(generator[j + 1], factor);
  }
  return result;
}

/* ============================================================== bit stream */

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

const dataCodewords = (spec: VersionSpec): number =>
  spec.groups.reduce((sum, [blocks, perBlock]) => sum + blocks * perBlock, 0);

/** Character-count field width. Byte mode uses 8 bits up to version 9, 16 after. */
const countBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Smallest version that holds the payload, or null if it exceeds version 10. */
function chooseVersion(byteLength: number): number | null {
  for (let version = 1; version <= VERSIONS.length; version += 1) {
    const capacity = dataCodewords(VERSIONS[version - 1]) * 8;
    if (4 + countBits(version) + byteLength * 8 <= capacity) return version;
  }
  return null;
}

/** Header, payload, padding, parity — interleaved into the final codeword run. */
function buildCodewords(bytes: readonly number[], version: number): Uint8Array {
  const spec = VERSIONS[version - 1];
  const total = dataCodewords(spec);
  const capacity = total * 8;

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator, then zero-fill to the byte boundary.
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(total);
  const written = bits.length / 8;
  for (let i = 0; i < written; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i * 8 + j];
    data[i] = byte;
  }
  for (let i = written; i < total; i += 1) data[i] = (i - written) % 2 === 0 ? PAD_A : PAD_B;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [blocks, perBlock] of spec.groups) {
    for (let b = 0; b < blocks; b += 1) {
      const block = data.subarray(offset, offset + perBlock);
      offset += perBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
    }
  }

  // Interleaving is what makes a burst of damage land across many blocks
  // instead of destroying one of them outright.
  const out: number[] = [];
  const longest = spec.groups.reduce((max, [, perBlock]) => Math.max(max, perBlock), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

/* ================================================================ masking */

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

const runPenalty = (run: number): number => (run >= 5 ? 3 + (run - 5) : 0);

function matchesFinderRun(line: readonly boolean[], at: number, reversed: boolean): boolean {
  for (let i = 0; i < FINDER_RUN.length; i += 1) {
    const expected = FINDER_RUN[reversed ? FINDER_RUN.length - 1 - i : i];
    if (line[at + i] !== expected) return false;
  }
  return true;
}

/** The standard's four penalty rules. Lower is more scannable. */
function penaltyScore(modules: readonly boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const scanLine = (line: readonly boolean[]) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        score += runPenalty(run);
        run = 1;
      }
    }
    score += runPenalty(run);

    for (let i = 0; i + FINDER_RUN.length <= size; i += 1) {
      if (matchesFinderRun(line, i, false)) score += 40;
      if (matchesFinderRun(line, i, true)) score += 40;
    }
  };

  for (let a = 0; a < size; a += 1) {
    scanLine(modules[a]);
    const column: boolean[] = new Array<boolean>(size);
    for (let b = 0; b < size; b += 1) column[b] = modules[b][a];
    scanLine(column);
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = modules[r][c];
      if (
        value === modules[r][c + 1] &&
        value === modules[r + 1][c] &&
        value === modules[r + 1][c + 1]
      ) {
        score += 3;
      }
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  return score + Math.floor(Math.abs(percent - 50) / 5) * 10;
}

/* ================================================================== matrix */

function buildMatrix(version: number, codewords: Uint8Array): boolean[][] {
  const spec = VERSIONS[version - 1];
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  /** Function patterns — never masked, never overwritten by data. */
  const fixed: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const setFixed = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    fixed[row][col] = true;
  };

  /* ---- finders and their separators ------------------------------------ */
  const finderOrigins: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [r0, c0] of finderOrigins) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFixed(r0 + dr, c0 + dc, inside && (ring || core));
      }
    }
  }

  /* ---- timing ---------------------------------------------------------- */
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFixed(6, i, dark);
    setFixed(i, 6, dark);
  }

  /* ---- alignment ------------------------------------------------------- */
  // Drawn after timing on purpose: where the two meet, alignment wins, and the
  // three centres that would sit on a finder are skipped by coordinate rather
  // than by "is it already fixed" — a legitimate centre lands on the timing
  // line, and testing occupancy would silently drop it.
  const centres = spec.align;
  const lastCentre = centres.length > 0 ? centres[centres.length - 1] : 0;
  for (const r of centres) {
    for (const c of centres) {
      const onFinder =
        (r === 6 && c === 6) ||
        (r === 6 && c === lastCentre) ||
        (r === lastCentre && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          setFixed(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  /* ---- version information (7 and up) ---------------------------------- */
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(a, b, dark);
      setFixed(b, a, dark);
    }
  }

  /* ---- format information ---------------------------------------------- */
  const drawFormat = (mask: number) => {
    const value = (EC_LEVEL_M << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((value << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;

    for (let i = 0; i <= 5; i += 1) setFixed(8, i, bit(i));
    setFixed(8, 7, bit(6));
    setFixed(8, 8, bit(7));
    setFixed(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) setFixed(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i += 1) setFixed(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) setFixed(8, size - 15 + i, bit(i));
    // Always dark, and it lands on top of the last strip module by design.
    setFixed(size - 8, 8, true);
  };

  // Reserve both strips before the data walk; the values are rewritten once a
  // mask has been chosen.
  drawFormat(0);

  /* ---- data ------------------------------------------------------------ */
  const totalBits = codewords.length * 8;
  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing line; the pairs step around it.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const row = upward ? size - 1 - step : step;
        if (fixed[row][col]) continue;
        modules[row][col] =
          index < totalBits && ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
        index += 1;
      }
    }
    upward = !upward;
  }

  /* ---- mask selection -------------------------------------------------- */
  const applyMask = (mask: number) => {
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!fixed[r][c] && maskAt(mask, r, c)) modules[r][c] = !modules[r][c];
      }
    }
  };

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const score = penaltyScore(modules);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(mask); // XOR is its own inverse — this reverts it.
  }

  applyMask(bestMask);
  drawFormat(bestMask);

  return modules;
}

/**
 * Encode a string as a QR matrix at error-correction level M.
 * Returns `null` when the payload is longer than version 10 can carry.
 */
export function encodeQR(value: string): QrMatrix | null {
  const bytes = utf8Bytes(value);
  const version = chooseVersion(bytes.length);
  if (version === null) return null;
  const modules = buildMatrix(version, buildCodewords(bytes, version));
  return { size: modules.length, modules, version };
}

/**
 * One SVG path for the whole matrix, merging horizontal runs into single
 * rectangles. A path per module would be a couple of thousand nodes; this is
 * typically under two hundred subpaths and renders in one draw call.
 */
export function qrPath(matrix: QrMatrix, quiet = QUIET_ZONE): string {
  const { size, modules } = matrix;
  const parts: string[] = [];
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) {
        c += 1;
        continue;
      }
      let run = 1;
      while (c + run < size && modules[r][c + run]) run += 1;
      parts.push(`M${c + quiet} ${r + quiet}h${run}v1h-${run}z`);
      c += run;
    }
  }
  return parts.join('');
}

/* ============================================================== components */

/**
 * `BUDDY-4KQ2` read aloud as a run-on word is useless; spaced out, VoiceOver
 * says each character, which is what someone writing it down needs.
 */
const spellOut = (code: string): string => code.split('').join(' ');

export type InviteQRProps = {
  /** The payload — normally the invite deep link. */
  value: string;
  /** The human-typeable code, shown under the matrix. */
  code: string;
  petName: string;
  /** Edge length of the matrix plate, in points. */
  size?: number;
  /** Line under the code — usually the expiry. */
  caption?: string;
  /** Actions rendered under the caption: share, copy, revoke. */
  actions?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type CodePlateProps = {
  code: string;
  petName: string;
  size?: number;
};

/**
 * The fallback: no matrix, just the code set as large as it will go. Used only
 * when a payload somehow exceeds version 10, where a rendered-but-unscannable
 * matrix would be actively misleading.
 */
export function CodePlate({ code, petName, size }: CodePlateProps) {
  const t = useTheme();
  const edge = size ?? t.spacing.colossal * 3;
  const plate = t.scheme === 'dark' ? t.color.text : t.color.surface;
  const ink = t.scheme === 'dark' ? t.color.textInverse : t.color.text;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Invite code for ${petName}: ${spellOut(code)}`}
      style={{
        width: edge,
        height: edge,
        borderRadius: t.radius.xl,
        backgroundColor: plate,
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.spacing.sm,
        padding: t.spacing.base,
      }}
    >
      <Icon name="paw" size="xl" color={t.scheme === 'dark' ? t.color.onPrimary : t.color.primary} />
      <Text
        variant="metric"
        align="center"
        numberOfLines={2}
        tabular
        style={{ color: ink, letterSpacing: t.spacing.xxs }}
      >
        {code}
      </Text>
    </View>
  );
}

export function InviteQR({
  value,
  code,
  petName,
  size,
  caption,
  actions,
  style,
  testID,
}: InviteQRProps) {
  const t = useTheme();
  const matrix = useMemo(() => encodeQR(value), [value]);
  const path = useMemo(() => (matrix ? qrPath(matrix) : ''), [matrix]);

  const edge = size ?? t.spacing.colossal * 3;
  // See the file header: a QR is a printed object, so the plate stays light in
  // both schemes and the module ink inverts with it.
  const plate = t.scheme === 'dark' ? t.color.text : t.color.surface;
  const ink = t.scheme === 'dark' ? t.color.textInverse : t.color.text;
  const mark = t.scheme === 'dark' ? t.color.onPrimary : t.color.primary;

  const grid = matrix ? matrix.size + QUIET_ZONE * 2 : 0;
  const wellSize = LOGO_MODULES + 1;
  const wellOrigin = matrix ? (grid - wellSize) / 2 : 0;

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : ZoomIn.duration(t.motion.duration.slow).easing(t.motion.easing.decelerate);

  return (
    <Surface
      variant="surface"
      elevation={2}
      radius="xxxl"
      padding="lg"
      testID={testID}
      style={[{ gap: t.spacing.base, alignItems: 'center' }, style]}
    >
      <Row gap="xs">
        <Icon name="qr-code-outline" size="xs" color="textTertiary" />
        <Text variant="overline" color="textTertiary">
          Scan to join {petName}
        </Text>
      </Row>

      <Animated.View entering={entering}>
        {matrix ? (
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`QR code that opens the invite to help with ${petName}. The code is ${spellOut(
              code,
            )}.`}
            style={{
              width: edge,
              height: edge,
              borderRadius: t.radius.xl,
              backgroundColor: plate,
              overflow: 'hidden',
            }}
          >
            <Svg width="100%" height="100%" viewBox={`0 0 ${grid} ${grid}`}>
              <Rect x={0} y={0} width={grid} height={grid} fill={plate} />
              <Path d={path} fill={ink} />
              {/* The well, then the mark. Punching the hole in the plate colour
                  keeps the surrounding modules crisp at any render size. */}
              <Rect
                x={wellOrigin}
                y={wellOrigin}
                width={wellSize}
                height={wellSize}
                rx={1}
                ry={1}
                fill={plate}
              />
              <PawGlyph
                x={wellOrigin + wellSize * 0.12}
                y={wellOrigin + wellSize * 0.12}
                size={wellSize * 0.76}
                color={mark}
              />
            </Svg>
          </View>
        ) : (
          <CodePlate code={code} petName={petName} size={edge} />
        )}
      </Animated.View>

      <Column align="center" gap="xxs">
        <Text
          variant="metricSmall"
          align="center"
          numberOfLines={1}
          tabular
          style={{ letterSpacing: t.spacing.xs }}
        >
          {code}
        </Text>
        <Text variant="caption" color="textTertiary" align="center">
          {caption ?? 'Or type this code in Furry Tracker'}
        </Text>
      </Column>

      {actions}
    </Surface>
  );
}

export default InviteQR;
