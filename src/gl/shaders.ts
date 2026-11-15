export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const PASS1_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform sampler2D u_mask;

uniform float u_blockAspect;
uniform float u_imageAspect;
uniform float u_zoom;
uniform vec2 u_pan;
uniform float u_rotRad;

uniform float u_brightness;
uniform float u_contrast;
uniform float u_gamma;
uniform float u_smoothStrength;
uniform vec2 u_texelSize;

// Maps block UV [0,1] -> image UV [0,1]
vec2 blockToImageUv(vec2 uv) {
  vec2 centered = uv - 0.5;
  // Correct for block aspect to isotropic space
  centered.x *= u_blockAspect;
  // Apply pan
  centered -= u_pan;
  // Apply inverse rotation
  float c = cos(-u_rotRad);
  float s = sin(-u_rotRad);
  vec2 rotated = vec2(
    centered.x * c - centered.y * s,
    centered.x * s + centered.y * c
  );
  // Apply inverse zoom
  rotated /= max(u_zoom, 0.05);
  // Map to image UV
  rotated.x /= u_imageAspect;
  return rotated + 0.5;
}

float sampleLumaAndMask(vec2 imgUv, out float maskVal) {
  if (imgUv.x < 0.0 || imgUv.x > 1.0 || imgUv.y < 0.0 || imgUv.y > 1.0) {
    maskVal = 0.0;
    return 1.0;
  }
  vec4 tex = texture(u_image, imgUv);
  maskVal = texture(u_mask, imgUv).r;
  float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
  // Apply tone adjustments
  luma = clamp(luma + u_brightness, 0.0, 1.0);
  luma = clamp((luma - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  luma = pow(luma, 1.0 / max(u_gamma, 0.1));
  return luma;
}

void main() {
  vec2 imgUv = blockToImageUv(v_uv);
  float centerMask = 0.0;
  float centerLuma = sampleLumaAndMask(imgUv, centerMask);

  if (u_smoothStrength <= 0.01 || centerMask < 0.01) {
    outColor = vec4(centerLuma, centerMask, 0.0, 1.0);
    return;
  }

  // Kuwahara edge-preserving filter in image space
  int radius = int(clamp(round(u_smoothStrength * 5.0), 1.0, 5.0));
  vec2 stepUv = u_texelSize * (1.0 + u_smoothStrength * 0.8);

  float mean[4];
  float m2[4];
  float count[4];
  for (int q = 0; q < 4; q++) {
    mean[q] = 0.0;
    m2[q] = 0.0;
    count[q] = 0.0;
  }

  for (int dy = -5; dy <= 5; dy++) {
    if (dy < -radius || dy > radius) continue;
    for (int dx = -5; dx <= 5; dx++) {
      if (dx < -radius || dx > radius) continue;
      float m = 0.0;
      float l = sampleLumaAndMask(imgUv + vec2(float(dx), float(dy)) * stepUv, m);
      if (dx <= 0 && dy <= 0) {
        mean[0] += l; m2[0] += l * l; count[0] += 1.0;
      }
      if (dx >= 0 && dy <= 0) {
        mean[1] += l; m2[1] += l * l; count[1] += 1.0;
      }
      if (dx <= 0 && dy >= 0) {
        mean[2] += l; m2[2] += l * l; count[2] += 1.0;
      }
      if (dx >= 0 && dy >= 0) {
        mean[3] += l; m2[3] += l * l; count[3] += 1.0;
      }
    }
  }

  float minVar = 1e9;
  float bestMean = centerLuma;
  for (int q = 0; q < 4; q++) {
    if (count[q] > 0.0) {
      float mu = mean[q] / count[q];
      float var = abs(m2[q] / count[q] - mu * mu);
      if (var < minVar) {
        minVar = var;
        bestMean = mu;
      }
    }
  }

  float blended = mix(centerLuma, bestMean, clamp(u_smoothStrength * 1.25, 0.0, 1.0));
  outColor = vec4(blended, centerMask, 0.0, 1.0);
}
`;

export const PASS2_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_pass1;
uniform sampler2D u_image;
uniform sampler2D u_mask;

uniform vec2 u_resolution;
uniform vec2 u_marginNorm; // (marginX, marginY) in 0..0.45
uniform int u_mode; // 0=bw, 1=adaptive, 2=posterize, 3=hatch
uniform float u_threshold;
uniform float u_adaptiveBias;
uniform float u_adaptiveRadius;
uniform int u_tones;
uniform float u_hatchAngle;
uniform float u_hatchSpacing;
uniform int u_hatchCross;
uniform float u_hatchContrast;
uniform int u_invert;
uniform int u_mirrorFlip;
uniform int u_bgFill; // 0=carved-white (1.0), 1=inked-black (0.0)
uniform int u_showOriginal;

uniform float u_blockAspect;
uniform float u_imageAspect;
uniform float u_zoom;
uniform vec2 u_pan;
uniform float u_rotRad;

vec2 blockToImageUv(vec2 uv) {
  vec2 centered = uv - 0.5;
  centered.x *= u_blockAspect;
  centered -= u_pan;
  float c = cos(-u_rotRad);
  float s = sin(-u_rotRad);
  vec2 rotated = vec2(
    centered.x * c - centered.y * s,
    centered.x * s + centered.y * c
  );
  rotated /= max(u_zoom, 0.05);
  rotated.x /= u_imageAspect;
  return rotated + 0.5;
}

void main() {
  vec2 uv = v_uv;
  if (u_mirrorFlip == 1) {
    uv.x = 1.0 - uv.x;
  }

  float bgVal = (u_bgFill == 0) ? 1.0 : 0.0;

  // Check block margin
  if (uv.x < u_marginNorm.x || uv.x > 1.0 - u_marginNorm.x ||
      uv.y < u_marginNorm.y || uv.y > 1.0 - u_marginNorm.y) {
    if (u_showOriginal == 1) {
      outColor = vec4(0.18, 0.18, 0.2, 1.0);
    } else {
      outColor = vec4(vec3(bgVal), 1.0);
    }
    return;
  }

  if (u_showOriginal == 1) {
    vec2 imgUv = blockToImageUv(uv);
    if (imgUv.x < 0.0 || imgUv.x > 1.0 || imgUv.y < 0.0 || imgUv.y > 1.0) {
      outColor = vec4(0.14, 0.14, 0.16, 1.0);
      return;
    }
    vec4 orig = texture(u_image, imgUv);
    float m = texture(u_mask, imgUv).r;
    // Tint removed area with subtle red-magenta checkerboard
    if (m < 0.5) {
      vec2 checker = floor(gl_FragCoord.xy / 8.0);
      float c = mod(checker.x + checker.y, 2.0) * 0.08 + 0.16;
      vec3 tinted = mix(orig.rgb * 0.35 + vec3(0.35, 0.08, 0.12), vec3(c), 0.35);
      outColor = vec4(tinted, 1.0);
    } else {
      outColor = vec4(orig.rgb, 1.0);
    }
    return;
  }

  vec4 p1 = texture(u_pass1, uv);
  float luma = p1.r;
  float mask = p1.g;

  if (mask < 0.5) {
    outColor = vec4(vec3(bgVal), 1.0);
    return;
  }

  float result = 0.0;

  if (u_mode == 0) {
    // Global B&W Threshold
    result = step(u_threshold, luma);
  } else if (u_mode == 1) {
    // Local Adaptive Threshold
    vec2 texel = 1.0 / u_resolution;
    float sum = 0.0;
    float cnt = 0.0;
    float stepScale = max(u_adaptiveRadius / 3.0, 1.0);
    for (int y = -3; y <= 3; y++) {
      for (int x = -3; x <= 3; x++) {
        vec2 suv = clamp(uv + vec2(float(x), float(y)) * texel * stepScale, 0.0, 1.0);
        vec4 sp = texture(u_pass1, suv);
        if (sp.g >= 0.5) {
          sum += sp.r;
          cnt += 1.0;
        }
      }
    }
    float localMean = (cnt > 0.0) ? (sum / cnt) : luma;
    result = (luma > (localMean - u_adaptiveBias)) ? 1.0 : 0.0;
  } else if (u_mode == 2) {
    // Multi-tone Posterize (2, 3, or 4 tones)
    float levels = float(max(u_tones, 2));
    float q = floor(clamp(luma, 0.0, 0.9999) * levels);
    result = q / (levels - 1.0);
  } else {
    // Woodcut / Linocut Directional Hatching
    vec2 px = v_uv * u_resolution;
    float rad = radians(u_hatchAngle);
    float cs = cos(rad);
    float sn = sin(rad);
    vec2 rot = vec2(px.x * cs - px.y * sn, px.x * sn + px.y * cs);

    float spacing = max(u_hatchSpacing, 2.5);
    float wave1 = abs(fract(rot.y / spacing) - 0.5) * 2.0;

    float adjLuma = clamp((luma - 0.5) * u_hatchContrast + 0.5, 0.0, 1.0);

    // Pure highlights stay white, deep shadows stay black
    if (adjLuma > 0.88) {
      result = 1.0;
    } else if (adjLuma < 0.12) {
      result = 0.0;
    } else {
      float h1 = step(wave1, adjLuma);
      if (u_hatchCross == 1 && adjLuma < 0.45) {
        float wave2 = abs(fract(rot.x / spacing) - 0.5) * 2.0;
        float h2 = step(wave2, adjLuma * 1.45);
        result = min(h1, h2);
      } else {
        result = h1;
      }
    }
  }

  if (u_invert == 1) {
    result = 1.0 - result;
  }

  outColor = vec4(vec3(result), 1.0);
}
`;
