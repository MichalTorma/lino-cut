import { jsPDF } from 'jspdf';
import { BlockSpec, PAPER_DIMS_MM, PrintLayout, ShaderParams } from '../types';

export interface SheetPlacement {
  xMm: number;
  yMm: number;
}

export interface ComputedSheet {
  paperW: number;
  paperH: number;
  cols: number;
  rows: number;
  maxCopies: number;
  activeCopies: number;
  placements: SheetPlacement[];
  fits: boolean;
}

export function computeSheetLayout(block: BlockSpec, layout: PrintLayout): ComputedSheet {
  const base = PAPER_DIMS_MM[layout.paper];
  const paperW = layout.orientation === 'portrait' ? base.width : base.height;
  const paperH = layout.orientation === 'portrait' ? base.height : base.width;

  const usableW = Math.max(paperW - layout.pageMarginMm * 2, 10);
  const usableH = Math.max(paperH - layout.pageMarginMm * 2, 10);

  const fits = block.widthMm <= usableW + 0.1 && block.heightMm <= usableH + 0.1;

  const cols = Math.max(
    1,
    Math.floor((usableW + layout.gapMm) / Math.max(block.widthMm + layout.gapMm, 1))
  );
  const rows = Math.max(
    1,
    Math.floor((usableH + layout.gapMm) / Math.max(block.heightMm + layout.gapMm, 1))
  );
  const maxCopies = fits ? cols * rows : 1;
  const activeCopies = layout.autoPack
    ? maxCopies
    : Math.min(Math.max(1, layout.copies), maxCopies);

  const usedCols = Math.min(cols, activeCopies);
  const usedRows = Math.ceil(activeCopies / cols);

  const gridW = usedCols * block.widthMm + Math.max(0, usedCols - 1) * layout.gapMm;
  const gridH = usedRows * block.heightMm + Math.max(0, usedRows - 1) * layout.gapMm;

  let startX = layout.pageMarginMm;
  let startY = layout.pageMarginMm;

  if (layout.alignment === 'center') {
    startX = (paperW - gridW) / 2;
    startY = (paperH - gridH) / 2;
  } else if (layout.alignment === 'top-right') {
    startX = paperW - layout.pageMarginMm - gridW;
    startY = layout.pageMarginMm;
  }

  const placements: SheetPlacement[] = [];
  for (let i = 0; i < activeCopies; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    placements.push({
      xMm: startX + c * (block.widthMm + layout.gapMm),
      yMm: startY + r * (block.heightMm + layout.gapMm),
    });
  }

  return {
    paperW,
    paperH,
    cols,
    rows,
    maxCopies,
    activeCopies,
    placements,
    fits,
  };
}

function pixelsToDataUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const imgData = new ImageData(new Uint8ClampedArray(pixels), width, height);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

function extractToneLayerPixels(
  composite: Uint8ClampedArray,
  targetToneVal: number,
  tolerance = 22
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(composite.length);
  for (let i = 0; i < composite.length; i += 4) {
    const v = composite[i];
    const match = Math.abs(v - targetToneVal) <= tolerance;
    const c = match ? 0 : 255; // Black ink for this layer's carved/printed area
    out[i] = c;
    out[i + 1] = c;
    out[i + 2] = c;
    out[i + 3] = 255;
  }
  return out;
}

function drawCropAndRegistrationMarks(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  cropMarks: boolean,
  regMarks: boolean
) {
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);

  if (cropMarks) {
    const len = 3.5;
    const off = 1.2;
    // Top-left
    doc.line(x - off - len, y, x - off, y);
    doc.line(x, y - off - len, x, y - off);
    // Top-right
    doc.line(x + w + off, y, x + w + off + len, y);
    doc.line(x + w, y - off - len, x + w, y - off);
    // Bottom-left
    doc.line(x - off - len, y + h, x - off, y + h);
    doc.line(x, y + h + off, x, y + h + off + len);
    // Bottom-right
    doc.line(x + w + off, y + h, x + w + off + len, y + h);
    doc.line(x + w, y + h + off, x + w, y + h + off + len);
  }

  if (regMarks) {
    const r = 1.8;
    const cross = 3.0;
    const regPoints: Array<[number, number]> = [
      [x - 4, y - 4],
      [x + w + 4, y - 4],
      [x - 4, y + h + 4],
      [x + w + 4, y + h + 4],
    ];
    for (const [rx, ry] of regPoints) {
      doc.circle(rx, ry, r, 'S');
      doc.line(rx - cross, ry, rx + cross, ry);
      doc.line(rx, ry - cross, rx, ry + cross);
    }
  }
}

export function exportPrintPdf(
  compositePixels: Uint8ClampedArray,
  pixelW: number,
  pixelH: number,
  block: BlockSpec,
  params: ShaderParams,
  layout: PrintLayout
): void {
  const sheet = computeSheetLayout(block, layout);
  const doc = new jsPDF({
    orientation: layout.orientation,
    unit: 'mm',
    format: [sheet.paperW, sheet.paperH],
    compress: true,
  });

  const pages: Array<{ label: string; dataUrl: string }> = [
    {
      label: `Composite (${block.widthMm}×${block.heightMm} mm${params.mirrorFlip ? ', Mirrored' : ''})`,
      dataUrl: pixelsToDataUrl(compositePixels, pixelW, pixelH),
    },
  ];

  if (layout.splitLayers && params.mode === 'posterize' && params.tones > 2) {
    const levels = params.tones;
    // Generate one page per tone from darkest (0) to lightest non-white
    for (let t = 0; t < levels - 1; t++) {
      const toneVal = Math.round((t / (levels - 1)) * 255);
      const layerPixels = extractToneLayerPixels(compositePixels, toneVal);
      pages.push({
        label: `Reduction Layer ${t + 1}/${levels - 1} (Tone ${t + 1})`,
        dataUrl: pixelsToDataUrl(layerPixels, pixelW, pixelH),
      });
    }
  }

  pages.forEach((page, pageIdx) => {
    if (pageIdx > 0) {
      doc.addPage([sheet.paperW, sheet.paperH], layout.orientation);
    }

    for (const pos of sheet.placements) {
      doc.addImage(
        page.dataUrl,
        'PNG',
        pos.xMm,
        pos.yMm,
        block.widthMm,
        block.heightMm,
        undefined,
        'FAST'
      );
      drawCropAndRegistrationMarks(
        doc,
        pos.xMm,
        pos.yMm,
        block.widthMm,
        block.heightMm,
        layout.cropMarks,
        layout.registrationMarks
      );
    }

    // Subtle footer label outside print area
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 110);
    doc.text(
      `LinoCut Studio • ${page.label} • ${sheet.activeCopies}× on ${layout.paper.toUpperCase()}`,
      layout.pageMarginMm,
      sheet.paperH - 3.5
    );
  });

  doc.save(`linocut-${block.widthMm}x${block.heightMm}mm.pdf`);
}

export function exportBlockPng(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  block: BlockSpec
): void {
  const url = pixelsToDataUrl(pixels, width, height);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linocut-${block.widthMm}x${block.heightMm}mm.png`;
  a.click();
}
