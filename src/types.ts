export type StylizeMode = 'bw' | 'adaptive' | 'posterize' | 'hatch';

export type CutoutTool = 'pan' | 'wand' | 'brush-erase' | 'brush-restore';

export type BackgroundFill = 'carved-white' | 'inked-black';

export type PaperSize = 'a4' | 'letter' | 'a3';
export type PaperOrientation = 'portrait' | 'landscape';
export type SheetAlignment = 'top-left' | 'top-right' | 'center';

export interface BlockSpec {
  preset: string;
  widthMm: number;
  heightMm: number;
  marginMm: number;
  unit: 'mm' | 'in';
}

export interface Placement {
  zoom: number;
  panX: number; // normalized in block space (-1..1)
  panY: number;
  rotationDeg: number;
}

export interface ShaderParams {
  brightness: number; // -0.5 .. 0.5
  contrast: number; // 0.2 .. 3.0
  gamma: number; // 0.4 .. 2.2
  smoothStrength: number; // 0 .. 1 (Kuwahara / edge-preserving)
  mode: StylizeMode;
  threshold: number; // 0.05 .. 0.95
  adaptiveBias: number; // -0.2 .. 0.2
  adaptiveRadius: number; // 2 .. 20 px
  tones: 2 | 3 | 4;
  hatchAngle: number; // 0 .. 180 deg
  hatchSpacing: number; // 3 .. 20 px
  hatchCross: boolean;
  hatchContrast: number; // 0.2 .. 2.0
  invert: boolean;
  mirrorFlip: boolean;
  bgFill: BackgroundFill;
}

export interface CleanupParams {
  minIslandPx: number; // 0 .. 150
  wandTolerance: number; // 5 .. 80
  wandEdgeAware: boolean;
  brushSizePx: number; // 4 .. 120
}

export interface PrintLayout {
  paper: PaperSize;
  orientation: PaperOrientation;
  alignment: SheetAlignment;
  autoPack: boolean;
  copies: number;
  gapMm: number;
  pageMarginMm: number;
  cropMarks: boolean;
  registrationMarks: boolean;
  splitLayers: boolean;
  dpi: number;
}

export const BLOCK_PRESETS: Array<{ id: string; label: string; widthMm: number; heightMm: number }> = [
  { id: '100x150', label: '100 × 150 mm (Postcard)', widthMm: 100, heightMm: 150 },
  { id: 'a6', label: 'A6 (105 × 148 mm)', widthMm: 105, heightMm: 148 },
  { id: 'a5', label: 'A5 (148 × 210 mm)', widthMm: 148, heightMm: 210 },
  { id: '150x200', label: '150 × 200 mm', widthMm: 150, heightMm: 200 },
  { id: 'sq150', label: '150 × 150 mm (Square)', widthMm: 150, heightMm: 150 },
  { id: 'a4', label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297 },
  { id: 'custom', label: 'Custom Size', widthMm: 120, heightMm: 160 },
];

export const PAPER_DIMS_MM: Record<PaperSize, { width: number; height: number; label: string }> = {
  a4: { width: 210, height: 297, label: 'A4 (210 × 297 mm)' },
  letter: { width: 215.9, height: 279.4, label: 'US Letter (8.5 × 11 in)' },
  a3: { width: 297, height: 420, label: 'A3 (297 × 420 mm)' },
};
