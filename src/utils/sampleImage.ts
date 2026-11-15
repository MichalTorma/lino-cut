/**
 * Generates a rich, high-contrast botanical sample image locally on a 2D canvas
 * so the user can test shaders, Magic Wand background removal, and PDF export offline.
 */
export function createOfflineSampleImage(): HTMLCanvasElement {
  const size = 800;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Soft warm studio background gradient (easy to test Magic Wand on)
  const bgGrad = ctx.createLinearGradient(0, 0, 0, size);
  bgGrad.addColorStop(0, '#e9e4d8');
  bgGrad.addColorStop(1, '#d3cbb8');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, size, size);

  // Subtle sun/halo behind subject
  const sunGrad = ctx.createRadialGradient(400, 310, 40, 400, 310, 260);
  sunGrad.addColorStop(0, '#f7f3e8');
  sunGrad.addColorStop(0.7, '#e2dac8');
  sunGrad.addColorStop(1, 'rgba(226, 218, 200, 0)');
  ctx.fillStyle = sunGrad;
  ctx.beginPath();
  ctx.arc(400, 310, 260, 0, Math.PI * 2);
  ctx.fill();

  // Ceramic vase
  ctx.save();
  const vaseGrad = ctx.createLinearGradient(290, 460, 510, 680);
  vaseGrad.addColorStop(0, '#2e4a52');
  vaseGrad.addColorStop(0.45, '#476f7a');
  vaseGrad.addColorStop(1, '#1a2c32');
  ctx.fillStyle = vaseGrad;
  ctx.beginPath();
  ctx.moveTo(345, 440);
  ctx.bezierCurveTo(345, 470, 270, 515, 285, 620);
  ctx.bezierCurveTo(295, 680, 335, 705, 400, 705);
  ctx.bezierCurveTo(465, 705, 505, 680, 515, 620);
  ctx.bezierCurveTo(530, 515, 455, 470, 455, 440);
  ctx.closePath();
  ctx.fill();

  // Vase rim
  ctx.fillStyle = '#20363c';
  ctx.beginPath();
  ctx.ellipse(400, 440, 58, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Stems
  ctx.strokeStyle = '#274229';
  ctx.lineCap = 'round';
  ctx.lineWidth = 10;
  const stems: Array<[number, number, number, number, number, number]> = [
    [400, 440, 360, 320, 290, 200],
    [400, 440, 410, 300, 420, 145],
    [400, 440, 460, 330, 535, 230],
  ];
  for (const [x0, y0, cx, cy, x1, y1] of stems) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }

  // Leaves
  const drawLeaf = (x: number, y: number, angle: number, len: number, wid: number, color: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const lg = ctx.createLinearGradient(0, -wid, len, wid);
    lg.addColorStop(0, color);
    lg.addColorStop(1, '#1e3522');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -wid, len, 0);
    ctx.quadraticCurveTo(len * 0.5, wid, 0, 0);
    ctx.fill();
    ctx.restore();
  };

  drawLeaf(365, 355, -2.5, 110, 32, '#3d6b42');
  drawLeaf(435, 365, -0.55, 115, 34, '#36613b');
  drawLeaf(340, 280, -2.7, 90, 26, '#487a4d');
  drawLeaf(470, 295, -0.35, 95, 28, '#417046');

  // Flowers
  const drawFlower = (cx: number, cy: number, petals: number, r: number, inner: string, outer: string) => {
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < petals; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI * 2) / petals);
      const pg = ctx.createRadialGradient(0, r * 0.4, 4, 0, r * 0.6, r);
      pg.addColorStop(0, inner);
      pg.addColorStop(1, outer);
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.58, r * 0.34, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#2c1e16';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  drawFlower(420, 150, 8, 72, '#d86c3a', '#8c2f18');
  drawFlower(290, 205, 7, 56, '#e09f3e', '#9c5a14');
  drawFlower(535, 235, 6, 52, '#c8553d', '#732318');

  return canvas;
}
