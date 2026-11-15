import { BlockSpec, Placement, ShaderParams } from '../types';
import {
  PASS1_FRAGMENT_SHADER,
  PASS2_FRAGMENT_SHADER,
  VERTEX_SHADER,
} from './shaders';

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to create program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || 'Unknown program link error';
    gl.deleteProgram(prog);
    throw new Error(info);
  }
  return prog;
}

const MODE_INDEX: Record<ShaderParams['mode'], number> = {
  bw: 0,
  adaptive: 1,
  posterize: 2,
  hatch: 3,
};

export class LinoEngine {
  private gl: WebGL2RenderingContext;
  private prog1: WebGLProgram;
  private prog2: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private imageTex: WebGLTexture;
  private maskTex: WebGLTexture;
  private pass1Fbo: WebGLFramebuffer;
  private pass1Tex: WebGLTexture;
  private exportFbo: WebGLFramebuffer;
  private exportTex: WebGLTexture;
  private fboWidth = 0;
  private fboHeight = 0;
  private exportWidth = 0;
  private exportHeight = 0;
  private imageWidth = 1;
  private imageHeight = 1;
  private hasImage = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is not supported in this browser.');
    }
    this.gl = gl;

    this.prog1 = createProgram(gl, VERTEX_SHADER, PASS1_FRAGMENT_SHADER);
    this.prog2 = createProgram(gl, VERTEX_SHADER, PASS2_FRAGMENT_SHADER);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const loc1 = gl.getAttribLocation(this.prog1, 'a_position');
    gl.enableVertexAttribArray(loc1);
    gl.vertexAttribPointer(loc1, 2, gl.FLOAT, false, 0, 0);

    this.imageTex = this.createLinearTexture();
    this.maskTex = this.createMaskTexture();

    const fbo1 = gl.createFramebuffer();
    const tex1 = this.createLinearTexture();
    if (!fbo1) throw new Error('Failed to create FBO');
    this.pass1Fbo = fbo1;
    this.pass1Tex = tex1;

    const fboExp = gl.createFramebuffer();
    const texExp = this.createLinearTexture();
    if (!fboExp) throw new Error('Failed to create export FBO');
    this.exportFbo = fboExp;
    this.exportTex = texExp;
  }

  private createLinearTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createMaskTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create mask texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  setImage(source: HTMLImageElement | ImageBitmap) {
    const gl = this.gl;
    this.imageWidth = source.width;
    this.imageHeight = source.height;
    this.hasImage = true;

    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  setMask(mask: Uint8Array, width: number, height: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      mask
    );
  }

  private ensurePass1Size(width: number, height: number) {
    if (this.fboWidth === width && this.fboHeight === height) return;
    const gl = this.gl;
    this.fboWidth = width;
    this.fboHeight = height;

    gl.bindTexture(gl.TEXTURE_2D, this.pass1Tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pass1Fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pass1Tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private ensureExportSize(width: number, height: number) {
    if (this.exportWidth === width && this.exportHeight === height) return;
    const gl = this.gl;
    this.exportWidth = width;
    this.exportHeight = height;

    gl.bindTexture(gl.TEXTURE_2D, this.exportTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.exportFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.exportTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawPipeline(
    targetFbo: WebGLFramebuffer | null,
    width: number,
    height: number,
    block: BlockSpec,
    placement: Placement,
    params: ShaderParams,
    showOriginal: boolean
  ) {
    const gl = this.gl;
    if (!this.hasImage) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.95, 0.95, 0.95, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    this.ensurePass1Size(width, height);

    const blockAspect = block.widthMm / Math.max(block.heightMm, 1);
    const imageAspect = this.imageWidth / Math.max(this.imageHeight, 1);
    const rotRad = (placement.rotationDeg * Math.PI) / 180;

    // Pass 1 -> pass1Fbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pass1Fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prog1);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(gl.getUniformLocation(this.prog1, 'u_image'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(gl.getUniformLocation(this.prog1, 'u_mask'), 1);

    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_blockAspect'), blockAspect);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_imageAspect'), imageAspect);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_zoom'), placement.zoom);
    gl.uniform2f(gl.getUniformLocation(this.prog1, 'u_pan'), placement.panX, placement.panY);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_rotRad'), rotRad);

    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_brightness'), params.brightness);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_contrast'), params.contrast);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_gamma'), params.gamma);
    gl.uniform1f(gl.getUniformLocation(this.prog1, 'u_smoothStrength'), params.smoothStrength);
    gl.uniform2f(
      gl.getUniformLocation(this.prog1, 'u_texelSize'),
      1 / Math.max(this.imageWidth, 1),
      1 / Math.max(this.imageHeight, 1)
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2 -> targetFbo (or screen if null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prog2);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pass1Tex);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_pass1'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_image'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_mask'), 2);

    const marginX = Math.min(Math.max(block.marginMm / Math.max(block.widthMm, 1), 0), 0.45);
    const marginY = Math.min(Math.max(block.marginMm / Math.max(block.heightMm, 1), 0), 0.45);

    gl.uniform2f(gl.getUniformLocation(this.prog2, 'u_resolution'), width, height);
    gl.uniform2f(gl.getUniformLocation(this.prog2, 'u_marginNorm'), marginX, marginY);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_mode'), MODE_INDEX[params.mode]);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_threshold'), params.threshold);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_adaptiveBias'), params.adaptiveBias);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_adaptiveRadius'), params.adaptiveRadius);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_tones'), params.tones);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_hatchAngle'), params.hatchAngle);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_hatchSpacing'), params.hatchSpacing);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_hatchCross'), params.hatchCross ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_hatchContrast'), params.hatchContrast);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_invert'), params.invert ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_mirrorFlip'), params.mirrorFlip ? 1 : 0);
    gl.uniform1i(
      gl.getUniformLocation(this.prog2, 'u_bgFill'),
      params.bgFill === 'carved-white' ? 0 : 1
    );
    gl.uniform1i(gl.getUniformLocation(this.prog2, 'u_showOriginal'), showOriginal ? 1 : 0);

    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_blockAspect'), blockAspect);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_imageAspect'), imageAspect);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_zoom'), placement.zoom);
    gl.uniform2f(gl.getUniformLocation(this.prog2, 'u_pan'), placement.panX, placement.panY);
    gl.uniform1f(gl.getUniformLocation(this.prog2, 'u_rotRad'), rotRad);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  renderPreview(
    width: number,
    height: number,
    block: BlockSpec,
    placement: Placement,
    params: ShaderParams,
    showOriginal: boolean
  ) {
    this.drawPipeline(null, width, height, block, placement, params, showOriginal);
  }

  /**
   * Renders the full pipeline offscreen at high resolution and returns top-down RGBA pixels.
   */
  renderToPixels(
    width: number,
    height: number,
    block: BlockSpec,
    placement: Placement,
    params: ShaderParams
  ): Uint8ClampedArray {
    const gl = this.gl;
    this.ensureExportSize(width, height);
    this.drawPipeline(this.exportFbo, width, height, block, placement, params, false);

    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.exportFbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Flip vertically for top-down Canvas/ImageData
    const flipped = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOffset = (height - 1 - y) * rowBytes;
      const dstOffset = y * rowBytes;
      flipped.set(raw.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    return flipped;
  }

  /**
   * Maps normalized DOM canvas coordinates (0..1, top-down) to image pixel coordinates.
   */
  domNormToImagePixel(
    domNormX: number,
    domNormY: number,
    block: BlockSpec,
    placement: Placement,
    mirrorFlip: boolean
  ): { x: number; y: number } | null {
    if (!this.hasImage) return null;
    let uvX = domNormX;
    if (mirrorFlip) uvX = 1 - uvX;
    const uvY = 1 - domNormY;

    const blockAspect = block.widthMm / Math.max(block.heightMm, 1);
    const imageAspect = this.imageWidth / Math.max(this.imageHeight, 1);
    const rotRad = (placement.rotationDeg * Math.PI) / 180;

    let cx = (uvX - 0.5) * blockAspect - placement.panX;
    let cy = uvY - 0.5 - placement.panY;

    const c = Math.cos(-rotRad);
    const s = Math.sin(-rotRad);
    const rx = (cx * c - cy * s) / Math.max(placement.zoom, 0.05) / imageAspect;
    const ry = (cx * s + cy * c) / Math.max(placement.zoom, 0.05);

    const imgUvX = rx + 0.5;
    const imgUvY = ry + 0.5;

    if (imgUvX < 0 || imgUvX > 1 || imgUvY < 0 || imgUvY > 1) return null;

    const px = Math.floor(imgUvX * this.imageWidth);
    const py = Math.floor((1 - imgUvY) * this.imageHeight);
    return {
      x: Math.min(Math.max(px, 0), this.imageWidth - 1),
      y: Math.min(Math.max(py, 0), this.imageHeight - 1),
    };
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.prog1);
    gl.deleteProgram(this.prog2);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.imageTex);
    gl.deleteTexture(this.maskTex);
    gl.deleteTexture(this.pass1Tex);
    gl.deleteTexture(this.exportTex);
    gl.deleteFramebuffer(this.pass1Fbo);
    gl.deleteFramebuffer(this.exportFbo);
  }
}
