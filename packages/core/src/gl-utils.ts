export interface DynMeta {
  _capturing: boolean;
  prevDrawRect: { x: number; y: number; w: number; h: number } | null;
  lastCapture: HTMLCanvasElement | null;
  needsRecapture: boolean;
  hoverClassName: string | null;
  _animating: boolean;
  _rafId: number | null;
  _lastCaptureTs: number;
  _heavyAnim: boolean;
  _isFixed?: boolean;
}

function compileShaderGL2(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Aqualens: createShader failed");
  gl.shaderSource(shader, src.trim());
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Aqualens shader error: ${info}`);
  }
  return shader;
}

export function createProgramGL2(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram {
  const vertexShader = compileShaderGL2(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = compileShaderGL2(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Aqualens program link error: ${info}`);
  }
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

export function computeGaussianKernel(radius: number): Float32Array {
  const sigma = Math.max(radius / 3.0, 0.0001);
  const kernel: number[] = [];
  let sum = 0;
  for (let index = 0; index <= radius; index++) {
    const weight = Math.exp((-0.5 * (index * index)) / (sigma * sigma));
    kernel.push(weight);
    sum += index === 0 ? weight : weight * 2;
  }
  return new Float32Array(kernel.map((weight) => weight / sum));
}

export function createFBO(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
  const fbo = gl.createFramebuffer()!;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

export interface BlurUniforms {
  inputTex: WebGLUniformLocation | null;
  texSize: WebGLUniformLocation | null;
  blurRadius: WebGLUniformLocation | null;
  blurWeights: WebGLUniformLocation | null;
}

export interface MaskUniforms {
  resolution: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  radiusCorners: WebGLUniformLocation | null;
  shapeCount: WebGLUniformLocation | null;
  mergeK: WebGLUniformLocation | null;
  shapes: WebGLUniformLocation | null;
}

export interface MainUniforms {
  tex: WebGLUniformLocation | null;
  blurredTex: WebGLUniformLocation | null;
  resolution: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  bounds: WebGLUniformLocation | null;
  texSize: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  radiusCorners: WebGLUniformLocation | null;
  refThickness: WebGLUniformLocation | null;
  refFactor: WebGLUniformLocation | null;
  refDispersion: WebGLUniformLocation | null;
  refFresnelRange: WebGLUniformLocation | null;
  refFresnelHardness: WebGLUniformLocation | null;
  refFresnelFactor: WebGLUniformLocation | null;
  glareRange: WebGLUniformLocation | null;
  glareHardness: WebGLUniformLocation | null;
  glareFactor: WebGLUniformLocation | null;
  glareConvergence: WebGLUniformLocation | null;
  glareOppositeFactor: WebGLUniformLocation | null;
  glareAngle: WebGLUniformLocation | null;
  blurEdge: WebGLUniformLocation | null;
  tint: WebGLUniformLocation | null;
  shapeCount: WebGLUniformLocation | null;
  mergeK: WebGLUniformLocation | null;
  shapes: WebGLUniformLocation | null;
  shadowShapes: WebGLUniformLocation | null;
  blurAmount: WebGLUniformLocation | null;
  shapeMaterials: WebGLUniformLocation | null;
}
