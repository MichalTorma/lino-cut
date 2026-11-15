import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eraser,
  Eye,
  FileDown,
  FlipHorizontal2,
  Hand,
  ImagePlus,
  Paintbrush,
  Printer,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react';
import { LinoEngine } from './gl/LinoEngine';
import {
  BLOCK_PRESETS,
  BlockSpec,
  CleanupParams,
  CutoutTool,
  PAPER_DIMS_MM,
  Placement,
  PrintLayout,
  ShaderParams,
  StylizeMode,
} from './types';
import {
  autoCutoutCorners,
  magicWandMask,
  paintBrushLine,
  removeSmallIslands,
} from './utils/cv';
import { computeSheetLayout, exportBlockPng, exportPrintPdf } from './utils/pdfExport';
import { createOfflineSampleImage } from './utils/sampleImage';

type InspectorTab = 'block' | 'cutout' | 'style' | 'print';

const MM_PER_INCH = 25.4;

export default function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cleanupCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<LinoEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Source image data for CV operations
  const sourceImageDataRef = useRef<ImageData | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const maskHistoryRef = useRef<Uint8Array[]>([]);
  const [historyLen, setHistoryLen] = useState(0);
  const [maskVersion, setMaskVersion] = useState(0);

  const [tab, setTab] = useState<InspectorTab>('style');
  const [tool, setTool] = useState<CutoutTool>('pan');
  const [showOriginal, setShowOriginal] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 700, height: 600 });
  const [imageDims, setImageDims] = useState({ width: 800, height: 800 });

  const [block, setBlock] = useState<BlockSpec>({
    preset: '100x150',
    widthMm: 100,
    heightMm: 150,
    marginMm: 4,
    unit: 'mm',
  });

  const [placement, setPlacement] = useState<Placement>({
    zoom: 1.0,
    panX: 0,
    panY: 0,
    rotationDeg: 0,
  });

  const [params, setParams] = useState<ShaderParams>({
    brightness: 0,
    contrast: 1.15,
    gamma: 1.0,
    smoothStrength: 0.45,
    mode: 'bw',
    threshold: 0.5,
    adaptiveBias: 0.03,
    adaptiveRadius: 9,
    tones: 3,
    hatchAngle: 35,
    hatchSpacing: 7,
    hatchCross: true,
    hatchContrast: 1.15,
    invert: false,
    mirrorFlip: false,
    bgFill: 'carved-white',
  });

  const [cleanup, setCleanup] = useState<CleanupParams>({
    minIslandPx: 0,
    wandTolerance: 24,
    wandEdgeAware: true,
    brushSizePx: 28,
  });

  const [printLayout, setPrintLayout] = useState<PrintLayout>({
    paper: 'a4',
    orientation: 'portrait',
    alignment: 'top-left',
    autoPack: true,
    copies: 1,
    gapMm: 6,
    pageMarginMm: 8,
    cropMarks: true,
    registrationMarks: true,
    splitLayers: true,
    dpi: 300,
  });

  // Pointer interaction refs
  const pointerStateRef = useRef<{
    active: boolean;
    lastX: number;
    lastY: number;
    lastImgX: number;
    lastImgY: number;
  }>({ active: false, lastX: 0, lastY: 0, lastImgX: 0, lastImgY: 0 });

  const pushMaskHistory = useCallback((prevMask: Uint8Array) => {
    const stack = maskHistoryRef.current;
    stack.push(new Uint8Array(prevMask));
    if (stack.length > 20) stack.shift();
    setHistoryLen(stack.length);
  }, []);

  const loadSourceElement = useCallback((el: HTMLImageElement | HTMLCanvasElement) => {
    const w = el.width;
    const h = el.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    sourceImageDataRef.current = imgData;

    const fullMask = new Uint8Array(w * h);
    fullMask.fill(255);
    maskRef.current = fullMask;
    maskHistoryRef.current = [];
    setHistoryLen(0);
    setImageDims({ width: w, height: h });

    if (engineRef.current) {
      if (el instanceof HTMLImageElement) {
        engineRef.current.setImage(el);
      } else {
        createImageBitmap(el).then((bmp) => {
          engineRef.current?.setImage(bmp);
          setMaskVersion((v) => v + 1);
        });
      }
      engineRef.current.setMask(fullMask, w, h);
    }

    setPlacement({ zoom: 1.0, panX: 0, panY: 0, rotationDeg: 0 });
    setMaskVersion((v) => v + 1);
  }, []);

  // Initialize WebGL2 Engine + Offline Sample Image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new LinoEngine(canvas);
    engineRef.current = engine;

    const sample = createOfflineSampleImage();
    loadSourceElement(sample);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [loadSourceElement]);

  // Observe viewport size for responsive frame scaling
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setViewportSize({ width: rect.width, height: rect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute preview frame dimensions preserving exact lino block aspect ratio
  const frameDims = useMemo(() => {
    const maxW = Math.max(180, viewportSize.width - 64);
    const maxH = Math.max(180, viewportSize.height - 80);
    const aspect = block.widthMm / Math.max(block.heightMm, 1);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    return { width: Math.round(w), height: Math.round(h) };
  }, [viewportSize, block.widthMm, block.heightMm]);

  // Render WebGL2 preview
  useEffect(() => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxW = Math.max(1, Math.round(frameDims.width * dpr));
    const pxH = Math.max(1, Math.round(frameDims.height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    engine.renderPreview(pxW, pxH, block, placement, params, showOriginal);
  }, [frameDims, block, placement, params, showOriginal, maskVersion]);

  // Debounced speckle/island cleanup preview overlay when minIslandPx > 0
  useEffect(() => {
    const overlay = cleanupCanvasRef.current;
    const engine = engineRef.current;
    if (!overlay || !engine || cleanup.minIslandPx <= 1 || showOriginal) return;

    const timer = window.setTimeout(() => {
      const w = Math.max(1, Math.round(frameDims.width));
      const h = Math.max(1, Math.round(frameDims.height));
      overlay.width = w;
      overlay.height = h;
      const pixels = engine.renderToPixels(w, h, block, placement, params);
      removeSmallIslands(pixels, w, h, cleanup.minIslandPx);
      const ctx = overlay.getContext('2d');
      if (ctx) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
      }
    }, 90);

    return () => window.clearTimeout(timer);
  }, [frameDims, block, placement, params, cleanup.minIslandPx, showOriginal, maskVersion]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      loadSourceElement(img);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handleUndoMask = () => {
    const stack = maskHistoryRef.current;
    const prev = stack.pop();
    if (!prev || !engineRef.current) return;
    maskRef.current = prev;
    engineRef.current.setMask(prev, imageDims.width, imageDims.height);
    setHistoryLen(stack.length);
    setMaskVersion((v) => v + 1);
  };

  const handleResetMask = () => {
    if (!maskRef.current || !engineRef.current) return;
    pushMaskHistory(maskRef.current);
    const full = new Uint8Array(imageDims.width * imageDims.height);
    full.fill(255);
    maskRef.current = full;
    engineRef.current.setMask(full, imageDims.width, imageDims.height);
    setMaskVersion((v) => v + 1);
  };

  const handleAutoCutout = () => {
    if (!sourceImageDataRef.current || !maskRef.current || !engineRef.current) return;
    pushMaskHistory(maskRef.current);
    const next = autoCutoutCorners(
      sourceImageDataRef.current,
      maskRef.current,
      cleanup.wandTolerance,
      cleanup.wandEdgeAware
    );
    maskRef.current = next;
    engineRef.current.setMask(next, imageDims.width, imageDims.height);
    setMaskVersion((v) => v + 1);
  };

  const getCanvasDomNorm = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      nx: (e.clientX - rect.left) / Math.max(rect.width, 1),
      ny: (e.clientY - rect.top) / Math.max(rect.height, 1),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { nx, ny } = getCanvasDomNorm(e);

    if (tool === 'pan') {
      pointerStateRef.current = {
        active: true,
        lastX: e.clientX,
        lastY: e.clientY,
        lastImgX: 0,
        lastImgY: 0,
      };
      return;
    }

    const engine = engineRef.current;
    const mask = maskRef.current;
    const imgData = sourceImageDataRef.current;
    if (!engine || !mask || !imgData) return;

    const pt = engine.domNormToImagePixel(nx, ny, block, placement, params.mirrorFlip);
    if (!pt) return;

    if (tool === 'wand') {
      pushMaskHistory(mask);
      const targetVal: 0 | 255 = e.altKey ? 255 : 0;
      const next = magicWandMask(
        imgData,
        mask,
        pt.x,
        pt.y,
        cleanup.wandTolerance,
        cleanup.wandEdgeAware,
        targetVal
      );
      maskRef.current = next;
      engine.setMask(next, imageDims.width, imageDims.height);
      setMaskVersion((v) => v + 1);
    } else if (tool === 'brush-erase' || tool === 'brush-restore') {
      pushMaskHistory(mask);
      const val: 0 | 255 = tool === 'brush-erase' ? 0 : 255;
      paintBrushLine(
        mask,
        imageDims.width,
        imageDims.height,
        pt.x,
        pt.y,
        pt.x,
        pt.y,
        cleanup.brushSizePx * 0.5,
        val
      );
      engine.setMask(mask, imageDims.width, imageDims.height);
      setMaskVersion((v) => v + 1);
      pointerStateRef.current = {
        active: true,
        lastX: e.clientX,
        lastY: e.clientY,
        lastImgX: pt.x,
        lastImgY: pt.y,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerStateRef.current.active) return;

    if (tool === 'pan') {
      const dx = e.clientX - pointerStateRef.current.lastX;
      const dy = e.clientY - pointerStateRef.current.lastY;
      pointerStateRef.current.lastX = e.clientX;
      pointerStateRef.current.lastY = e.clientY;

      const blockAspect = block.widthMm / Math.max(block.heightMm, 1);
      const signX = params.mirrorFlip ? -1 : 1;
      setPlacement((p) => ({
        ...p,
        panX: p.panX + (dx / Math.max(frameDims.width, 1)) * blockAspect * signX,
        panY: p.panY - dy / Math.max(frameDims.height, 1),
      }));
      return;
    }

    if (tool === 'brush-erase' || tool === 'brush-restore') {
      const engine = engineRef.current;
      const mask = maskRef.current;
      if (!engine || !mask) return;
      const { nx, ny } = getCanvasDomNorm(e);
      const pt = engine.domNormToImagePixel(nx, ny, block, placement, params.mirrorFlip);
      if (!pt) return;
      const val: 0 | 255 = tool === 'brush-erase' ? 0 : 255;
      paintBrushLine(
        mask,
        imageDims.width,
        imageDims.height,
        pointerStateRef.current.lastImgX,
        pointerStateRef.current.lastImgY,
        pt.x,
        pt.y,
        cleanup.brushSizePx * 0.5,
        val
      );
      pointerStateRef.current.lastImgX = pt.x;
      pointerStateRef.current.lastImgY = pt.y;
      engine.setMask(mask, imageDims.width, imageDims.height);
      setMaskVersion((v) => v + 1);
    }
  };

  const handlePointerUp = () => {
    pointerStateRef.current.active = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.07 : 0.93;
    setPlacement((p) => ({
      ...p,
      zoom: Math.min(Math.max(p.zoom * factor, 0.2), 6.0),
    }));
  };

  const renderExportBuffer = () => {
    const engine = engineRef.current;
    if (!engine) return null;
    const pxW = Math.min(3600, Math.max(300, Math.round((block.widthMm / MM_PER_INCH) * printLayout.dpi)));
    const pxH = Math.min(3600, Math.max(300, Math.round((block.heightMm / MM_PER_INCH) * printLayout.dpi)));
    const pixels = engine.renderToPixels(pxW, pxH, block, placement, params);
    if (cleanup.minIslandPx > 1) {
      // Scale island threshold proportionally from preview frame to export DPI
      const scale = (pxW * pxH) / Math.max(frameDims.width * frameDims.height, 1);
      removeSmallIslands(pixels, pxW, pxH, Math.round(cleanup.minIslandPx * scale));
    }
    return { pixels, pxW, pxH };
  };

  const handleExportPdf = () => {
    const res = renderExportBuffer();
    if (!res) return;
    exportPrintPdf(res.pixels, res.pxW, res.pxH, block, params, printLayout);
  };

  const handleExportPng = () => {
    const res = renderExportBuffer();
    if (!res) return;
    exportBlockPng(res.pixels, res.pxW, res.pxH, block);
  };

  const sheetPreview = useMemo(() => computeSheetLayout(block, printLayout), [block, printLayout]);

  const toDisplayUnit = (mm: number) =>
    block.unit === 'mm' ? Number(mm.toFixed(1)) : Number((mm / MM_PER_INCH).toFixed(2));
  const fromDisplayUnit = (val: number) =>
    block.unit === 'mm' ? val : val * MM_PER_INCH;

  const cursorStyle =
    tool === 'pan' ? 'grab' : tool === 'wand' ? 'crosshair' : 'cell';

  return (
    <div
      className="studio"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFile(true);
      }}
      onDragLeave={() => setIsDraggingFile(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingFile(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
    >
      {/* Top Studio Bar */}
      <header className="topbar">
        <div className="brand">
          <span>LinoCut Studio</span>
          <span className="brand-badge">100% Offline • WebGL2</span>
        </div>

        <div className="toolbar-group">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <button className="btn" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={14} /> Load Image
          </button>

          <button
            className={`btn ${tool === 'pan' ? 'active' : ''}`}
            onClick={() => setTool('pan')}
            title="Pan & Zoom inside lino frame"
          >
            <Hand size={14} /> Frame
          </button>
          <button
            className={`btn ${tool === 'wand' ? 'active' : ''}`}
            onClick={() => setTool('wand')}
            title="Magic Wand cutout (click to erase, Alt+click to restore)"
          >
            <Wand2 size={14} /> Wand
          </button>
          <button
            className={`btn ${tool === 'brush-erase' ? 'active' : ''}`}
            onClick={() => setTool('brush-erase')}
            title="Erase background brush"
          >
            <Eraser size={14} /> Erase
          </button>
          <button
            className={`btn ${tool === 'brush-restore' ? 'active' : ''}`}
            onClick={() => setTool('brush-restore')}
            title="Restore foreground brush"
          >
            <Paintbrush size={14} /> Restore
          </button>

          <button
            className="btn icon-only"
            disabled={historyLen === 0}
            onClick={handleUndoMask}
            title="Undo mask edit"
          >
            <Undo2 size={14} />
          </button>
        </div>

        <div className="toolbar-group">
          <button
            className={`btn ${params.mirrorFlip ? 'active' : ''}`}
            onClick={() => setParams((p) => ({ ...p, mirrorFlip: !p.mirrorFlip }))}
            title="Mirror horizontally for block transfer"
          >
            <FlipHorizontal2 size={14} /> Mirror
          </button>
          <button
            className={`btn ${showOriginal ? 'active' : ''}`}
            onPointerDown={() => setShowOriginal(true)}
            onPointerUp={() => setShowOriginal(false)}
            onPointerLeave={() => setShowOriginal(false)}
            title="Hold to peek at original image & cutout mask"
          >
            <Eye size={14} /> Peek
          </button>
          <button className="btn primary" onClick={handleExportPdf}>
            <Printer size={14} /> Export PDF
          </button>
        </div>
      </header>

      {/* Center Interactive Lino Block Viewport */}
      <main className="viewport" ref={viewportRef}>
        {isDraggingFile && (
          <div className="drop-overlay">
            <ImagePlus size={32} />
            <span>Drop image to load into LinoCut Studio</span>
          </div>
        )}

        <div
          className="block-frame"
          style={{
            width: `${frameDims.width}px`,
            height: `${frameDims.height}px`,
            cursor: cursorStyle,
          }}
        >
          <canvas
            ref={canvasRef}
            className="block-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          />
          {cleanup.minIslandPx > 1 && !showOriginal && (
            <canvas
              ref={cleanupCanvasRef}
              className="block-canvas"
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        <div className="block-label">
          <span>
            Lino Block: <strong>{block.widthMm} × {block.heightMm} mm</strong>
          </span>
          <span>•</span>
          <span>Zoom: {Math.round(placement.zoom * 100)}%</span>
          {params.mirrorFlip && (
            <>
              <span>•</span>
              <span>Mirrored</span>
            </>
          )}
          {tool === 'wand' && (
            <>
              <span>•</span>
              <span>Click to cut out • Alt+Click to restore</span>
            </>
          )}
        </div>
      </main>

      {/* Right Inspector */}
      <aside className="inspector">
        <div className="tabs">
          <button
            className={`tab ${tab === 'style' ? 'active' : ''}`}
            onClick={() => setTab('style')}
          >
            Style
          </button>
          <button
            className={`tab ${tab === 'cutout' ? 'active' : ''}`}
            onClick={() => setTab('cutout')}
          >
            Cutout
          </button>
          <button
            className={`tab ${tab === 'block' ? 'active' : ''}`}
            onClick={() => setTab('block')}
          >
            Block
          </button>
          <button
            className={`tab ${tab === 'print' ? 'active' : ''}`}
            onClick={() => setTab('print')}
          >
            Print PDF
          </button>
        </div>

        <div className="inspector-body">
          {tab === 'style' && (
            <>
              <div className="section">
                <div className="section-title">Carving Mode</div>
                <div className="segmented">
                  {(
                    [
                      ['bw', 'B&W'],
                      ['adaptive', 'Adaptive'],
                      ['posterize', 'Tones'],
                      ['hatch', 'Hatch'],
                    ] as Array<[StylizeMode, string]>
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      className={params.mode === m ? 'active' : ''}
                      onClick={() => setParams((p) => ({ ...p, mode: m }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {params.mode === 'bw' && (
                  <div className="field">
                    <div className="field-row">
                      <span className="field-label">Threshold</span>
                      <span className="field-value">{Math.round(params.threshold * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={0.95}
                      step={0.01}
                      value={params.threshold}
                      onChange={(e) =>
                        setParams((p) => ({ ...p, threshold: Number(e.target.value) }))
                      }
                    />
                  </div>
                )}

                {params.mode === 'adaptive' && (
                  <>
                    <div className="field">
                      <div className="field-row">
                        <span className="field-label">Local Radius</span>
                        <span className="field-value">{params.adaptiveRadius} px</span>
                      </div>
                      <input
                        type="range"
                        min={2}
                        max={24}
                        step={1}
                        value={params.adaptiveRadius}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, adaptiveRadius: Number(e.target.value) }))
                        }
                      />
                    </div>
                    <div className="field">
                      <div className="field-row">
                        <span className="field-label">Detail Bias</span>
                        <span className="field-value">{params.adaptiveBias.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={-0.15}
                        max={0.15}
                        step={0.005}
                        value={params.adaptiveBias}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, adaptiveBias: Number(e.target.value) }))
                        }
                      />
                    </div>
                  </>
                )}

                {params.mode === 'posterize' && (
                  <div className="field">
                    <span className="field-label">Gray Levels (Reduction Print)</span>
                    <div className="segmented">
                      {([2, 3, 4] as const).map((t) => (
                        <button
                          key={t}
                          className={params.tones === t ? 'active' : ''}
                          onClick={() => setParams((p) => ({ ...p, tones: t }))}
                        >
                          {t} Tones
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {params.mode === 'hatch' && (
                  <>
                    <div className="field">
                      <div className="field-row">
                        <span className="field-label">Line Angle</span>
                        <span className="field-value">{params.hatchAngle}°</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={180}
                        step={1}
                        value={params.hatchAngle}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, hatchAngle: Number(e.target.value) }))
                        }
                      />
                    </div>
                    <div className="field">
                      <div className="field-row">
                        <span className="field-label">Line Spacing</span>
                        <span className="field-value">{params.hatchSpacing} px</span>
                      </div>
                      <input
                        type="range"
                        min={3}
                        max={20}
                        step={0.5}
                        value={params.hatchSpacing}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, hatchSpacing: Number(e.target.value) }))
                        }
                      />
                    </div>
                    <div className="field">
                      <div className="field-row">
                        <span className="field-label">Hatch Contrast</span>
                        <span className="field-value">{params.hatchContrast.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0.4}
                        max={2.2}
                        step={0.05}
                        value={params.hatchContrast}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, hatchContrast: Number(e.target.value) }))
                        }
                      />
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={params.hatchCross}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, hatchCross: e.target.checked }))
                        }
                      />
                      <span>Cross-hatch dark shadows</span>
                    </label>
                  </>
                )}
              </div>

              <div className="section">
                <div className="section-title">Pre-Processing (GPU)</div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Edge-Preserving Smooth</span>
                    <span className="field-value">
                      {Math.round(params.smoothStrength * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={params.smoothStrength}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, smoothStrength: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Contrast</span>
                    <span className="field-value">{params.contrast.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.3}
                    max={2.5}
                    step={0.05}
                    value={params.contrast}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, contrast: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Brightness</span>
                    <span className="field-value">{params.brightness.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={-0.4}
                    max={0.4}
                    step={0.01}
                    value={params.brightness}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, brightness: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Gamma</span>
                    <span className="field-value">{params.gamma.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.4}
                    max={2.2}
                    step={0.05}
                    value={params.gamma}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, gamma: Number(e.target.value) }))
                    }
                  />
                </div>
              </div>

              <div className="section">
                <div className="section-title">Transfer & Polarity</div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={params.invert}
                    onChange={(e) => setParams((p) => ({ ...p, invert: e.target.checked }))}
                  />
                  <span>Invert black / white</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={params.mirrorFlip}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, mirrorFlip: e.target.checked }))
                    }
                  />
                  <span>Mirror flip horizontally (for carving)</span>
                </label>
              </div>
            </>
          )}

          {tab === 'cutout' && (
            <>
              <div className="section">
                <div className="section-title">Background Cutout (0 MB Local CV)</div>
                <button className="btn primary" onClick={handleAutoCutout}>
                  <Sparkles size={14} /> Auto-Cutout Corners
                </button>
                <p className="hint">
                  Or select <strong>Wand</strong> in the top bar and click background regions
                  (hold Alt to restore). Use <strong>Erase / Restore</strong> brushes for fine
                  edges.
                </p>

                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Wand Tolerance</span>
                    <span className="field-value">{cleanup.wandTolerance}</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={80}
                    step={1}
                    value={cleanup.wandTolerance}
                    onChange={(e) =>
                      setCleanup((c) => ({ ...c, wandTolerance: Number(e.target.value) }))
                    }
                  />
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={cleanup.wandEdgeAware}
                    onChange={(e) =>
                      setCleanup((c) => ({ ...c, wandEdgeAware: e.target.checked }))
                    }
                  />
                  <span>Edge-aware barrier (stops at crisp edges)</span>
                </label>

                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Brush Size</span>
                    <span className="field-value">{cleanup.brushSizePx} px</span>
                  </div>
                  <input
                    type="range"
                    min={6}
                    max={120}
                    step={2}
                    value={cleanup.brushSizePx}
                    onChange={(e) =>
                      setCleanup((c) => ({ ...c, brushSizePx: Number(e.target.value) }))
                    }
                  />
                </div>

                <div className="grid-2">
                  <button
                    className="btn"
                    disabled={historyLen === 0}
                    onClick={handleUndoMask}
                  >
                    <Undo2 size={14} /> Undo
                  </button>
                  <button className="btn" onClick={handleResetMask}>
                    <RotateCcw size={14} /> Reset Mask
                  </button>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Removed Background Fill</div>
                <div className="segmented">
                  <button
                    className={params.bgFill === 'carved-white' ? 'active' : ''}
                    onClick={() => setParams((p) => ({ ...p, bgFill: 'carved-white' }))}
                  >
                    Carved (White)
                  </button>
                  <button
                    className={params.bgFill === 'inked-black' ? 'active' : ''}
                    onClick={() => setParams((p) => ({ ...p, bgFill: 'inked-black' }))}
                  >
                    Inked (Black)
                  </button>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Carvability Cleanup</div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Remove Speckles Smaller Than</span>
                    <span className="field-value">{cleanup.minIslandPx} px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    step={2}
                    value={cleanup.minIslandPx}
                    onChange={(e) =>
                      setCleanup((c) => ({ ...c, minIslandPx: Number(e.target.value) }))
                    }
                  />
                </div>
                <p className="hint">
                  Eliminates tiny isolated dots that are impossible to carve cleanly.
                </p>
              </div>
            </>
          )}

          {tab === 'block' && (
            <>
              <div className="section">
                <div className="section-title">Physical Lino Block Size</div>
                <div className="field">
                  <span className="field-label">Preset</span>
                  <select
                    value={block.preset}
                    onChange={(e) => {
                      const preset = BLOCK_PRESETS.find((p) => p.id === e.target.value);
                      if (!preset) return;
                      setBlock((b) => ({
                        ...b,
                        preset: preset.id,
                        widthMm: preset.id === 'custom' ? b.widthMm : preset.widthMm,
                        heightMm: preset.id === 'custom' ? b.heightMm : preset.heightMm,
                      }));
                    }}
                  >
                    {BLOCK_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="segmented">
                  <button
                    className={block.unit === 'mm' ? 'active' : ''}
                    onClick={() => setBlock((b) => ({ ...b, unit: 'mm' }))}
                  >
                    Millimeters (mm)
                  </button>
                  <button
                    className={block.unit === 'in' ? 'active' : ''}
                    onClick={() => setBlock((b) => ({ ...b, unit: 'in' }))}
                  >
                    Inches (in)
                  </button>
                </div>

                <div className="grid-2">
                  <div className="field">
                    <span className="field-label">Width ({block.unit})</span>
                    <input
                      type="number"
                      min={10}
                      max={600}
                      step={block.unit === 'mm' ? 1 : 0.1}
                      value={toDisplayUnit(block.widthMm)}
                      onChange={(e) =>
                        setBlock((b) => ({
                          ...b,
                          preset: 'custom',
                          widthMm: Math.max(10, fromDisplayUnit(Number(e.target.value) || 10)),
                        }))
                      }
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">Height ({block.unit})</span>
                    <input
                      type="number"
                      min={10}
                      max={600}
                      step={block.unit === 'mm' ? 1 : 0.1}
                      value={toDisplayUnit(block.heightMm)}
                      onChange={(e) =>
                        setBlock((b) => ({
                          ...b,
                          preset: 'custom',
                          heightMm: Math.max(10, fromDisplayUnit(Number(e.target.value) || 10)),
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Border Margin</span>
                    <span className="field-value">{block.marginMm} mm</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={25}
                    step={0.5}
                    value={block.marginMm}
                    onChange={(e) =>
                      setBlock((b) => ({ ...b, marginMm: Number(e.target.value) }))
                    }
                  />
                </div>
              </div>

              <div className="section">
                <div className="section-title">Framing on Block</div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Zoom</span>
                    <span className="field-value">{Math.round(placement.zoom * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={4.0}
                    step={0.02}
                    value={placement.zoom}
                    onChange={(e) =>
                      setPlacement((p) => ({ ...p, zoom: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <div className="field-row">
                    <span className="field-label">Rotation</span>
                    <span className="field-value">{placement.rotationDeg}°</span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={placement.rotationDeg}
                    onChange={(e) =>
                      setPlacement((p) => ({ ...p, rotationDeg: Number(e.target.value) }))
                    }
                  />
                </div>
                <button
                  className="btn"
                  onClick={() =>
                    setPlacement({ zoom: 1.0, panX: 0, panY: 0, rotationDeg: 0 })
                  }
                >
                  <RotateCcw size={14} /> Reset Framing
                </button>
              </div>
            </>
          )}

          {tab === 'print' && (
            <>
              <div className="section">
                <div className="section-title">Paper & Sheet Alignment</div>
                <div className="grid-2">
                  <div className="field">
                    <span className="field-label">Paper</span>
                    <select
                      value={printLayout.paper}
                      onChange={(e) =>
                        setPrintLayout((l) => ({
                          ...l,
                          paper: e.target.value as PrintLayout['paper'],
                        }))
                      }
                    >
                      {Object.entries(PAPER_DIMS_MM).map(([id, info]) => (
                        <option key={id} value={id}>
                          {info.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <span className="field-label">Orientation</span>
                    <select
                      value={printLayout.orientation}
                      onChange={(e) =>
                        setPrintLayout((l) => ({
                          ...l,
                          orientation: e.target.value as PrintLayout['orientation'],
                        }))
                      }
                    >
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Corner / Sheet Alignment</span>
                  <div className="segmented">
                    {(
                      [
                        ['top-left', 'Top-Left'],
                        ['center', 'Center'],
                        ['top-right', 'Top-Right'],
                      ] as const
                    ).map(([al, label]) => (
                      <button
                        key={al}
                        className={printLayout.alignment === al ? 'active' : ''}
                        onClick={() => setPrintLayout((l) => ({ ...l, alignment: al }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Multi-Print Packing</div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={printLayout.autoPack}
                    onChange={(e) =>
                      setPrintLayout((l) => ({ ...l, autoPack: e.target.checked }))
                    }
                  />
                  <span>
                    Auto-fill sheet (fits <strong>{sheetPreview.maxCopies}×</strong>)
                  </span>
                </label>

                {!printLayout.autoPack && (
                  <div className="field">
                    <div className="field-row">
                      <span className="field-label">Copies per Sheet</span>
                      <span className="field-value">
                        {sheetPreview.activeCopies} / {sheetPreview.maxCopies}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={Math.max(1, sheetPreview.maxCopies)}
                      step={1}
                      value={sheetPreview.activeCopies}
                      onChange={(e) =>
                        setPrintLayout((l) => ({ ...l, copies: Number(e.target.value) }))
                      }
                    />
                  </div>
                )}

                <div className="grid-2">
                  <div className="field">
                    <span className="field-label">Gap (mm)</span>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={printLayout.gapMm}
                      onChange={(e) =>
                        setPrintLayout((l) => ({ ...l, gapMm: Number(e.target.value) || 0 }))
                      }
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">Margin (mm)</span>
                    <input
                      type="number"
                      min={2}
                      max={30}
                      value={printLayout.pageMarginMm}
                      onChange={(e) =>
                        setPrintLayout((l) => ({
                          ...l,
                          pageMarginMm: Math.max(2, Number(e.target.value) || 2),
                        }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Marks & Reduction Layers</div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={printLayout.cropMarks}
                    onChange={(e) =>
                      setPrintLayout((l) => ({ ...l, cropMarks: e.target.checked }))
                    }
                  />
                  <span>Include crop marks</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={printLayout.registrationMarks}
                    onChange={(e) =>
                      setPrintLayout((l) => ({
                        ...l,
                        registrationMarks: e.target.checked,
                      }))
                    }
                  />
                  <span>Include corner registration marks</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={printLayout.splitLayers}
                    disabled={!(params.mode === 'posterize' && params.tones > 2)}
                    onChange={(e) =>
                      setPrintLayout((l) => ({ ...l, splitLayers: e.target.checked }))
                    }
                  />
                  <span>
                    Split into separate layer pages{' '}
                    {params.mode === 'posterize' && params.tones > 2
                      ? `(${params.tones - 1} layers)`
                      : '(3–4 Tones mode)'}
                  </span>
                </label>
              </div>

              <div className="sheet-preview-box">
                <div
                  className="sheet-paper"
                  style={{
                    width: 140,
                    height: (140 * sheetPreview.paperH) / sheetPreview.paperW,
                  }}
                >
                  {sheetPreview.placements.map((p, idx) => (
                    <div
                      key={idx}
                      className="sheet-block-rect"
                      style={{
                        left: `${(p.xMm / sheetPreview.paperW) * 100}%`,
                        top: `${(p.yMm / sheetPreview.paperH) * 100}%`,
                        width: `${(block.widthMm / sheetPreview.paperW) * 100}%`,
                        height: `${(block.heightMm / sheetPreview.paperH) * 100}%`,
                      }}
                    />
                  ))}
                </div>
                <span className="hint">
                  {sheetPreview.fits
                    ? `${sheetPreview.activeCopies}× ${block.widthMm}×${block.heightMm} mm on ${printLayout.paper.toUpperCase()} (${printLayout.alignment})`
                    : 'Block exceeds paper printable area'}
                </span>
              </div>

              <div className="grid-2">
                <button className="btn primary" onClick={handleExportPdf}>
                  <Printer size={14} /> Export PDF
                </button>
                <button className="btn" onClick={handleExportPng}>
                  <FileDown size={14} /> Export PNG
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
