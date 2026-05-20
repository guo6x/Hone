/**
 * SVG Sprite data for Hone Buddy (Desktop version).
 * Each species defines shapes, colors, and eye-render helpers.
 */

export type Species = 'duck' | 'cat' | 'robot' | 'owl' | 'ghost' | 'blob' | 'axolotl';

export type BuddyState = 'idle' | 'thinking' | 'working' | 'success' | 'error' | 'suggestion';

/** Shape primitive for building SVG bodies */
export interface SvgShape {
  tag: 'circle' | 'ellipse' | 'rect' | 'path' | 'polygon' | 'line';
  attrs: Record<string, string | number>;
}

export interface SpeciesData {
  name: Species;
  bodyColor: string;
  accentColor: string;
  bodyShapes: SvgShape[];
  /** Extra decorations (ears, gills, antenna, etc.) */
  decorations: SvgShape[];
}

// ── Eye helpers (returns SVG shapes for left/right eye area) ──

export function getEyeShapes(
  state: BuddyState,
  frame: number,
  lx: number,
  ly: number,
  rx: number,
  ry: number,
): SvgShape[] {
  const blink = state === 'idle' && frame === 2;
  if (blink) {
    return [
      { tag: 'line', attrs: { x1: lx - 4, y1: ly, x2: lx + 4, y2: ly, stroke: '#2A2A3A', strokeWidth: 2, strokeLinecap: 'round' } },
      { tag: 'line', attrs: { x1: rx - 4, y1: ry, x2: rx + 4, y2: ry, stroke: '#2A2A3A', strokeWidth: 2, strokeLinecap: 'round' } },
    ];
  }
  switch (state) {
    case 'idle':
      return [
        { tag: 'circle', attrs: { cx: lx, cy: ly, r: 4, fill: '#2A2A3A' } },
        { tag: 'circle', attrs: { cx: lx + 1.5, cy: ly - 1.5, r: 1.2, fill: '#FFF' } },
        { tag: 'circle', attrs: { cx: rx, cy: ry, r: 4, fill: '#2A2A3A' } },
        { tag: 'circle', attrs: { cx: rx + 1.5, cy: ry - 1.5, r: 1.2, fill: '#FFF' } },
      ];
    case 'thinking': {
      // Spiral / looking-around eyes
      const ox = frame % 2 === 0 ? 2 : -2;
      return [
        { tag: 'circle', attrs: { cx: lx + ox, cy: ly, r: 4.5, fill: 'none', stroke: '#2A2A3A', strokeWidth: 1.5 } },
        { tag: 'circle', attrs: { cx: lx + ox, cy: ly, r: 1.5, fill: '#2A2A3A' } },
        { tag: 'circle', attrs: { cx: rx + ox, cy: ry, r: 4.5, fill: 'none', stroke: '#2A2A3A', strokeWidth: 1.5 } },
        { tag: 'circle', attrs: { cx: rx + ox, cy: ry, r: 1.5, fill: '#2A2A3A' } },
      ];
    }
    case 'working':
      // Happy squint ^_^
      return [
        { tag: 'path', attrs: { d: `M${lx - 4},${ly + 1} Q${lx},${ly - 5} ${lx + 4},${ly + 1}`, fill: 'none', stroke: '#2A2A3A', strokeWidth: 2, strokeLinecap: 'round' } },
        { tag: 'path', attrs: { d: `M${rx - 4},${ry + 1} Q${rx},${ry - 5} ${rx + 4},${ry + 1}`, fill: 'none', stroke: '#2A2A3A', strokeWidth: 2, strokeLinecap: 'round' } },
      ];
    case 'success':
      // Heart eyes ♥
      return [
        { tag: 'path', attrs: { d: `M${lx},${ly + 3} C${lx - 5},${ly - 3} ${lx - 1},${ly - 6} ${lx},${ly - 2} C${lx + 1},${ly - 6} ${lx + 5},${ly - 3} ${lx},${ly + 3}Z`, fill: '#E84060', stroke: 'none' } },
        { tag: 'path', attrs: { d: `M${rx},${ry + 3} C${rx - 5},${ry - 3} ${rx - 1},${ry - 6} ${rx},${ry - 2} C${rx + 1},${ry - 6} ${rx + 5},${ry - 3} ${rx},${ry + 3}Z`, fill: '#E84060', stroke: 'none' } },
      ];
    case 'error':
      // X eyes
      return [
        { tag: 'line', attrs: { x1: lx - 3, y1: ly - 3, x2: lx + 3, y2: ly + 3, stroke: '#D33', strokeWidth: 2.5, strokeLinecap: 'round' } },
        { tag: 'line', attrs: { x1: lx + 3, y1: ly - 3, x2: lx - 3, y2: ly + 3, stroke: '#D33', strokeWidth: 2.5, strokeLinecap: 'round' } },
        { tag: 'line', attrs: { x1: rx - 3, y1: ry - 3, x2: rx + 3, y2: ry + 3, stroke: '#D33', strokeWidth: 2.5, strokeLinecap: 'round' } },
        { tag: 'line', attrs: { x1: rx + 3, y1: ry - 3, x2: rx - 3, y2: ry + 3, stroke: '#D33', strokeWidth: 2.5, strokeLinecap: 'round' } },
      ];
    case 'suggestion':
      // Exclamation mark eyes
      return [
        { tag: 'line', attrs: { x1: lx, y1: ly - 5, x2: lx, y2: ly + 1, stroke: '#D4A853', strokeWidth: 2.5, strokeLinecap: 'round' } },
        { tag: 'circle', attrs: { cx: lx, cy: ly + 4, r: 1.2, fill: '#D4A853' } },
        { tag: 'line', attrs: { x1: rx, y1: ry - 5, x2: rx, y2: ry + 1, stroke: '#D4A853', strokeWidth: 2.5, strokeLinecap: 'round' } },
        { tag: 'circle', attrs: { cx: rx, cy: ry + 4, r: 1.2, fill: '#D4A853' } },
      ];
    default:
      return [];
  }
}

// ── Species definitions ──

const speciesMap: Record<Species, SpeciesData> = {
  duck: {
    name: 'duck',
    bodyColor: '#FFD93D',
    accentColor: '#FF8C42',
    bodyShapes: [
      { tag: 'ellipse', attrs: { cx: 40, cy: 48, rx: 22, ry: 20, fill: '#FFD93D' } },
      { tag: 'circle', attrs: { cx: 40, cy: 28, r: 16, fill: '#FFD93D' } },
      // beak
      { tag: 'ellipse', attrs: { cx: 55, cy: 32, rx: 8, ry: 4, fill: '#FF8C42' } },
    ],
    decorations: [
      // wing
      { tag: 'ellipse', attrs: { cx: 24, cy: 48, rx: 8, ry: 12, fill: '#F0C430', transform: 'rotate(-15 24 48)' } },
      // cheek blush
      { tag: 'circle', attrs: { cx: 30, cy: 34, r: 3, fill: '#FFB6C1', opacity: 0.5 } },
      // feet
      { tag: 'path', attrs: { d: 'M32,67 L28,72 L36,72 Z', fill: '#FF8C42' } },
      { tag: 'path', attrs: { d: 'M44,67 L40,72 L48,72 Z', fill: '#FF8C42' } },
    ],
  },
  cat: {
    name: 'cat',
    bodyColor: '#B8A0D4',
    accentColor: '#8B6DB5',
    bodyShapes: [
      { tag: 'ellipse', attrs: { cx: 40, cy: 50, rx: 20, ry: 18, fill: '#B8A0D4' } },
      { tag: 'circle', attrs: { cx: 40, cy: 30, r: 16, fill: '#B8A0D4' } },
    ],
    decorations: [
      // ears
      { tag: 'polygon', attrs: { points: '24,24 20,8 32,20', fill: '#B8A0D4' } },
      { tag: 'polygon', attrs: { points: '56,24 60,8 48,20', fill: '#B8A0D4' } },
      { tag: 'polygon', attrs: { points: '25,22 22,12 31,20', fill: '#D4B8E8' } },
      { tag: 'polygon', attrs: { points: '55,22 58,12 49,20', fill: '#D4B8E8' } },
      // nose + mouth
      { tag: 'path', attrs: { d: 'M40,36 L38,39 L42,39 Z', fill: '#E8A0B0' } },
      { tag: 'path', attrs: { d: 'M40,39 Q37,43 34,41', fill: 'none', stroke: '#8B6DB5', strokeWidth: 1, strokeLinecap: 'round' } },
      { tag: 'path', attrs: { d: 'M40,39 Q43,43 46,41', fill: 'none', stroke: '#8B6DB5', strokeWidth: 1, strokeLinecap: 'round' } },
      // whiskers
      { tag: 'line', attrs: { x1: 14, y1: 33, x2: 30, y2: 35, stroke: '#8B6DB5', strokeWidth: 0.8 } },
      { tag: 'line', attrs: { x1: 14, y1: 37, x2: 30, y2: 37, stroke: '#8B6DB5', strokeWidth: 0.8 } },
      { tag: 'line', attrs: { x1: 50, y1: 35, x2: 66, y2: 33, stroke: '#8B6DB5', strokeWidth: 0.8 } },
      { tag: 'line', attrs: { x1: 50, y1: 37, x2: 66, y2: 37, stroke: '#8B6DB5', strokeWidth: 0.8 } },
      // tail
      { tag: 'path', attrs: { d: 'M58,55 Q72,45 68,35', fill: 'none', stroke: '#B8A0D4', strokeWidth: 4, strokeLinecap: 'round' } },
      // cheek
      { tag: 'circle', attrs: { cx: 28, cy: 36, r: 3, fill: '#FFB6C1', opacity: 0.4 } },
      { tag: 'circle', attrs: { cx: 52, cy: 36, r: 3, fill: '#FFB6C1', opacity: 0.4 } },
    ],
  },
  robot: {
    name: 'robot',
    bodyColor: '#8BA4B8',
    accentColor: '#5A8FAF',
    bodyShapes: [
      // body
      { tag: 'rect', attrs: { x: 18, y: 38, width: 44, height: 30, rx: 6, fill: '#8BA4B8' } },
      // head
      { tag: 'rect', attrs: { x: 22, y: 14, width: 36, height: 28, rx: 8, fill: '#9CB4C8' } },
      // screen face
      { tag: 'rect', attrs: { x: 26, y: 18, width: 28, height: 20, rx: 4, fill: '#1A2636' } },
    ],
    decorations: [
      // antenna
      { tag: 'line', attrs: { x1: 40, y1: 14, x2: 40, y2: 5, stroke: '#5A8FAF', strokeWidth: 2 } },
      { tag: 'circle', attrs: { cx: 40, cy: 4, r: 3, fill: '#5AE0A0' } },
      // arms
      { tag: 'rect', attrs: { x: 10, y: 42, width: 8, height: 4, rx: 2, fill: '#7A94A8' } },
      { tag: 'rect', attrs: { x: 62, y: 42, width: 8, height: 4, rx: 2, fill: '#7A94A8' } },
      // legs
      { tag: 'rect', attrs: { x: 26, y: 68, width: 8, height: 6, rx: 2, fill: '#7A94A8' } },
      { tag: 'rect', attrs: { x: 46, y: 68, width: 8, height: 6, rx: 2, fill: '#7A94A8' } },
      // mouth on screen
      { tag: 'line', attrs: { x1: 34, y1: 34, x2: 46, y2: 34, stroke: '#5AE0A0', strokeWidth: 1.5, strokeLinecap: 'round' } },
    ],
  },
  owl: {
    name: 'owl',
    bodyColor: '#A0784C',
    accentColor: '#D4A853',
    bodyShapes: [
      { tag: 'ellipse', attrs: { cx: 40, cy: 46, rx: 22, ry: 24, fill: '#A0784C' } },
      // belly
      { tag: 'ellipse', attrs: { cx: 40, cy: 54, rx: 14, ry: 14, fill: '#D4C0A0' } },
    ],
    decorations: [
      // ear tufts
      { tag: 'polygon', attrs: { points: '22,26 16,10 28,22', fill: '#8B6840' } },
      { tag: 'polygon', attrs: { points: '58,26 64,10 52,22', fill: '#8B6840' } },
      // eye circles (big round face discs)
      { tag: 'circle', attrs: { cx: 32, cy: 36, r: 10, fill: '#D4C0A0' } },
      { tag: 'circle', attrs: { cx: 48, cy: 36, r: 10, fill: '#D4C0A0' } },
      // beak
      { tag: 'polygon', attrs: { points: '40,42 37,47 43,47', fill: '#D4A853' } },
      // wing hints
      { tag: 'path', attrs: { d: 'M18,40 Q12,50 18,60', fill: 'none', stroke: '#8B6840', strokeWidth: 2 } },
      { tag: 'path', attrs: { d: 'M62,40 Q68,50 62,60', fill: 'none', stroke: '#8B6840', strokeWidth: 2 } },
    ],
  },
  ghost: {
    name: 'ghost',
    bodyColor: '#E8E8F0',
    accentColor: '#C0C0D8',
    bodyShapes: [
      // body with wavy bottom
      { tag: 'path', attrs: { d: 'M18,30 Q18,12 40,12 Q62,12 62,30 L62,58 Q57,64 52,58 Q47,64 42,58 Q37,64 32,58 Q27,64 22,58 L18,58 Z', fill: '#E8E8F0' } },
    ],
    decorations: [
      // small arms
      { tag: 'ellipse', attrs: { cx: 20, cy: 40, rx: 5, ry: 3, fill: '#D8D8E8', transform: 'rotate(-20 20 40)' } },
      { tag: 'ellipse', attrs: { cx: 60, cy: 40, rx: 5, ry: 3, fill: '#D8D8E8', transform: 'rotate(20 60 40)' } },
      // cheek blush
      { tag: 'circle', attrs: { cx: 28, cy: 38, r: 3, fill: '#FFB6C1', opacity: 0.3 } },
      { tag: 'circle', attrs: { cx: 52, cy: 38, r: 3, fill: '#FFB6C1', opacity: 0.3 } },
    ],
  },
  blob: {
    name: 'blob',
    bodyColor: '#5ECFB0',
    accentColor: '#3AAF90',
    bodyShapes: [
      { tag: 'ellipse', attrs: { cx: 40, cy: 44, rx: 26, ry: 22, fill: '#5ECFB0' } },
    ],
    decorations: [
      // highlight
      { tag: 'ellipse', attrs: { cx: 33, cy: 36, rx: 8, ry: 5, fill: '#80E8D0', opacity: 0.5, transform: 'rotate(-15 33 36)' } },
      // mouth
      { tag: 'path', attrs: { d: 'M36,50 Q40,55 44,50', fill: 'none', stroke: '#2A8A70', strokeWidth: 1.5, strokeLinecap: 'round' } },
      // cheeks
      { tag: 'circle', attrs: { cx: 25, cy: 46, r: 3.5, fill: '#FFB6C1', opacity: 0.35 } },
      { tag: 'circle', attrs: { cx: 55, cy: 46, r: 3.5, fill: '#FFB6C1', opacity: 0.35 } },
    ],
  },
  axolotl: {
    name: 'axolotl',
    bodyColor: '#F7A0B0',
    accentColor: '#E87090',
    bodyShapes: [
      // body
      { tag: 'ellipse', attrs: { cx: 40, cy: 48, rx: 20, ry: 18, fill: '#F7A0B0' } },
      // head
      { tag: 'circle', attrs: { cx: 40, cy: 30, r: 16, fill: '#F7A0B0' } },
    ],
    decorations: [
      // external gills (frilly crown) - left
      { tag: 'path', attrs: { d: 'M24,26 Q14,18 18,10', fill: 'none', stroke: '#E87090', strokeWidth: 2.5, strokeLinecap: 'round' } },
      { tag: 'path', attrs: { d: 'M22,30 Q10,24 12,14', fill: 'none', stroke: '#E87090', strokeWidth: 2, strokeLinecap: 'round' } },
      { tag: 'path', attrs: { d: 'M24,22 Q18,12 22,6', fill: 'none', stroke: '#F0889A', strokeWidth: 2, strokeLinecap: 'round' } },
      // external gills - right
      { tag: 'path', attrs: { d: 'M56,26 Q66,18 62,10', fill: 'none', stroke: '#E87090', strokeWidth: 2.5, strokeLinecap: 'round' } },
      { tag: 'path', attrs: { d: 'M58,30 Q70,24 68,14', fill: 'none', stroke: '#E87090', strokeWidth: 2, strokeLinecap: 'round' } },
      { tag: 'path', attrs: { d: 'M56,22 Q62,12 58,6', fill: 'none', stroke: '#F0889A', strokeWidth: 2, strokeLinecap: 'round' } },
      // wide smile
      { tag: 'path', attrs: { d: 'M32,36 Q40,44 48,36', fill: 'none', stroke: '#D06078', strokeWidth: 1.5, strokeLinecap: 'round' } },
      // cheek blush
      { tag: 'circle', attrs: { cx: 28, cy: 34, r: 3.5, fill: '#FFB6C1', opacity: 0.5 } },
      { tag: 'circle', attrs: { cx: 52, cy: 34, r: 3.5, fill: '#FFB6C1', opacity: 0.5 } },
      // dots on head
      { tag: 'circle', attrs: { cx: 36, cy: 20, r: 1.2, fill: '#E87090', opacity: 0.4 } },
      { tag: 'circle', attrs: { cx: 44, cy: 20, r: 1.2, fill: '#E87090', opacity: 0.4 } },
      // tail
      { tag: 'path', attrs: { d: 'M55,58 Q68,55 72,48', fill: 'none', stroke: '#F7A0B0', strokeWidth: 4, strokeLinecap: 'round' } },
    ],
  },
};

/** Eye positions per species [leftX, leftY, rightX, rightY] */
export const eyePositions: Record<Species, [number, number, number, number]> = {
  duck:    [33, 26, 45, 26],
  cat:     [33, 28, 47, 28],
  robot:   [33, 27, 47, 27],
  owl:     [32, 35, 48, 35],
  ghost:   [33, 30, 47, 30],
  blob:    [34, 40, 46, 40],
  axolotl: [34, 28, 46, 28],
};

export function getSpeciesData(species: Species): SpeciesData {
  return speciesMap[species];
}
