/**
 * Perceptual RGB color distance (redmean approximation, 0..~765)
 */
function colorDist(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const rMean = (r1 + r2) * 0.5;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(
    (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db
  );
}

/**
 * Edge-aware perceptual flood-fill on imageData to erase or restore mask regions.
 * Returns a new Uint8Array mask (255 = foreground, 0 = background).
 */
export function magicWandMask(
  imageData: ImageData,
  currentMask: Uint8Array,
  seedX: number,
  seedY: number,
  tolerance: number,
  edgeAware: boolean,
  targetValue: 0 | 255
): Uint8Array {
  const { width, height, data } = imageData;
  const nextMask = new Uint8Array(currentMask);
  if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return nextMask;

  const seedIdx = (seedY * width + seedX) * 4;
  const sr = data[seedIdx];
  const sg = data[seedIdx + 1];
  const sb = data[seedIdx + 2];

  // Scale tolerance (5..80) to perceptual distance (~15..240)
  const maxDist = tolerance * 3.0;
  const edgeThreshold = Math.max(32, tolerance * 1.6);

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const startPos = seedY * width + seedX;
  queue[tail++] = startPos;
  visited[startPos] = 1;

  while (head < tail) {
    const pos = queue[head++];
    nextMask[pos] = targetValue;

    const x = pos % width;
    const y = (pos - x) / width;

    const neighbors = [
      x > 0 ? pos - 1 : -1,
      x < width - 1 ? pos + 1 : -1,
      y > 0 ? pos - width : -1,
      y < height - 1 ? pos + width : -1,
    ];

    const pIdx = pos * 4;
    const pr = data[pIdx];
    const pg = data[pIdx + 1];
    const pb = data[pIdx + 2];

    for (let i = 0; i < 4; i++) {
      const nPos = neighbors[i];
      if (nPos < 0 || visited[nPos]) continue;

      const nIdx = nPos * 4;
      const nr = data[nIdx];
      const ng = data[nIdx + 1];
      const nb = data[nIdx + 2];

      const distToSeed = colorDist(sr, sg, sb, nr, ng, nb);
      if (distToSeed > maxDist) continue;

      if (edgeAware) {
        const stepDist = colorDist(pr, pg, pb, nr, ng, nb);
        if (stepDist > edgeThreshold) continue;
      }

      visited[nPos] = 1;
      queue[tail++] = nPos;
    }
  }

  return nextMask;
}

/**
 * Auto-cutout from the 4 corners using edge-aware flood-fill.
 */
export function autoCutoutCorners(
  imageData: ImageData,
  currentMask: Uint8Array,
  tolerance: number,
  edgeAware: boolean
): Uint8Array {
  const { width, height } = imageData;
  let mask = new Uint8Array(currentMask);
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [cx, cy] of corners) {
    if (mask[cy * width + cx] !== 0) {
      mask = magicWandMask(imageData, mask, cx, cy, tolerance, edgeAware, 0);
    }
  }
  return mask;
}

/**
 * Paints a smooth circular brush stroke between (x0, y0) and (x1, y1) on the mask.
 */
export function paintBrushLine(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: 0 | 255
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));
  const r2 = radius * radius;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + dx * t);
    const cy = Math.round(y0 + dy * t);

    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y++) {
      const oy = y - cy;
      const rowOffset = y * width;
      for (let x = minX; x <= maxX; x++) {
        const ox = x - cx;
        if (ox * ox + oy * oy <= r2) {
          mask[rowOffset + x] = value;
        }
      }
    }
  }
}

/**
 * Removes isolated speckles/islands smaller than minAreaPx using 4-connected BFS.
 * Operates in-place on RGBA pixel buffer (quantized grayscale values).
 */
export function removeSmallIslands(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  minAreaPx: number
): void {
  if (minAreaPx <= 1) return;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const component = new Int32Array(total);

  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;

    const targetVal = pixels[start * 4];
    let head = 0;
    let tail = 0;
    let compLen = 0;

    queue[tail++] = start;
    visited[start] = 1;

    // Track most common neighbor value in case component is small
    let neighborValSum = 0;
    let neighborCount = 0;
    let firstNeighborVal = targetVal;

    while (head < tail) {
      const pos = queue[head++];
      component[compLen++] = pos;

      const x = pos % width;
      const y = (pos - x) / width;

      const neighbors = [
        x > 0 ? pos - 1 : -1,
        x < width - 1 ? pos + 1 : -1,
        y > 0 ? pos - width : -1,
        y < height - 1 ? pos + width : -1,
      ];

      for (let i = 0; i < 4; i++) {
        const nPos = neighbors[i];
        if (nPos < 0) continue;
        const nVal = pixels[nPos * 4];
        if (Math.abs(nVal - targetVal) <= 8) {
          if (!visited[nPos]) {
            visited[nPos] = 1;
            queue[tail++] = nPos;
          }
        } else {
          if (neighborCount === 0) firstNeighborVal = nVal;
          neighborValSum += nVal;
          neighborCount++;
        }
      }
    }

    if (compLen < minAreaPx && neighborCount > 0) {
      // Replace small island with nearest surrounding tone
      const avg = Math.round(neighborValSum / neighborCount);
      const fillVal = Math.abs(avg - firstNeighborVal) < 25 ? firstNeighborVal : avg;
      for (let i = 0; i < compLen; i++) {
        const idx = component[i] * 4;
        pixels[idx] = fillVal;
        pixels[idx + 1] = fillVal;
        pixels[idx + 2] = fillVal;
      }
    }
  }
}
