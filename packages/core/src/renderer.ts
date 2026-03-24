import {
  VERTEX_SHADER,
  BLUR_H_FRAGMENT,
  BLUR_V_FRAGMENT,
  COMPOSITE_FRAGMENT,
  MAIN_FRAGMENT,
  MASK_FRAGMENT,
} from "./shaders";
import { debounce, effectiveZ } from "./utils";
import type { AqualensConfig, AqualensRendererInstance } from "./types";
import { AqualensLens } from "./lens";
import {
  computeGaussianKernel,
  createProgramGL2,
  type DynMeta,
  type BlurUniforms,
  type MainUniforms,
  type MaskUniforms,
} from "./gl-utils";
import {
  ensureBlurFBOs,
  destroyBlurFBOs,
  updateBlurKernel,
  ensureComposeFbo,
  destroyComposeFbo,
  copyToCompose,
  runBlurPasses,
  flattenGroupToCompose,
} from "./renderer-fbo";
import {
  resizeCanvas,
  doResizeCapture,
  enableResizeFallback,
  disableResizeFallback,
  captureSnapshotImpl,
} from "./renderer-snapshot";
import {
  renderLens,
  renderMergedGroup,
  renderGroupMask,
  MAX_SHAPES,
} from "./renderer-draw";
import {
  updateDynamicVideos,
  updateDynamicNodes,
  addDynamicElementImpl,
  isIgnored,
} from "./renderer-dynamic";

export class AqualensRenderer implements AqualensRendererInstance {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  lenses: AqualensLens[] = [];
  /**
   * When true and lenses use different z-indices, higher layers clip lower ones
   * and each lens samples the original snapshot (macOS-style overlap).
   */
  opaqueOverlap = false;
  texture: WebGLTexture | null = null;
  textureWidth = 0;
  textureHeight = 0;
  scaleFactor = 1;
  useExternalTicker = false;

  _hblurProgram!: WebGLProgram;
  _vblurProgram!: WebGLProgram;
  _mainProgram!: WebGLProgram;
  _maskProgram!: WebGLProgram;
  _hblurU!: BlurUniforms;
  _vblurU!: BlurUniforms;
  _mainU!: MainUniforms;
  _maskU!: MaskUniforms;
  _vao!: WebGLVertexArrayObject;

  _fboA: WebGLFramebuffer | null = null;
  _fboATexture: WebGLTexture | null = null;
  _fboB: WebGLFramebuffer | null = null;
  _fboBTexture: WebGLTexture | null = null;
  _blurFboW = 0;
  _blurFboH = 0;

  _blurWeights: Float32Array = computeGaussianKernel(1);
  _currentBlurRadius = 1;
  _blurDownsample = 1;
  _blurScaledRadius = 1;

  _composeFbo: WebGLFramebuffer | null = null;
  _composeTex: WebGLTexture | null = null;
  _composeFboW = 0;
  _composeFboH = 0;
  _srcReadFbo: WebGLFramebuffer | null = null;
  _canvasCopyTex: WebGLTexture | null = null;
  _canvasCopyTexW = 0;
  _canvasCopyTexH = 0;
  _compositeProgram!: WebGLProgram;
  _compositeU!: {
    src: WebGLUniformLocation | null;
    srcRegion: WebGLUniformLocation | null;
  };
  _activeSourceTex: WebGLTexture | null = null;

  _scrollUpdateCounter = 0;
  _isScrolling = false;
  _capturing = false;
  _snapshotResolution: number;
  snapshotTarget: HTMLElement;
  staticSnapshotCanvas: HTMLCanvasElement | null = null;

  _pendingActivation: AqualensLens[] = [];
  _rafId: number | null = null;
  _invalidated = false;

  _dynamicNodes: { element: HTMLElement; _cleanup: () => void }[] = [];
  _dynMeta = new WeakMap<HTMLElement, DynMeta>();
  _fixedElementsDiscovered = false;
  readonly _dynamicStyleSheet: CSSStyleSheet | null = null;
  _dynamicRemovalObserver: MutationObserver | null = null;
  _dynamicRemovalRaf: number | null = null;
  _dynRecaptureInFlight = 0;

  _videoNodes: HTMLVideoElement[] = [];
  readonly _tmpCanvas: HTMLCanvasElement;
  readonly _tmpCtx: CanvasRenderingContext2D;

  readonly _workerEnabled: boolean;
  readonly _dynWorker?: Worker;
  _dynJobs?: Map<string, { x: number; y: number; w: number; h: number }>;

  _compositeCtx?: CanvasRenderingContext2D;

  readonly _onResizeHandler: () => void;
  readonly _onResizeHideHandler: () => void;
  _resizeFallbackActive = false;
  _resizeFallbackCleanups: (() => void)[] = [];
  _resizeGeneration = 0;
  _resizePending = false;
  _scrollCheckRafId: number | null = null;
  readonly _resizeObserver?: ResizeObserver;
  _destroyed = false;

  _scratchShapeData = new Float32Array(MAX_SHAPES * 2 * 4);
  _scratchShadowShapes = new Float32Array(MAX_SHAPES * 2 * 4);
  _scratchMaterialData = new Float32Array(MAX_SHAPES * 4 * 4);

  constructor(snapshotTarget: HTMLElement, snapshotResolution = 1.0) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none";
    this.canvas.setAttribute("data-liquid-ignore", "");
    document.body.appendChild(this.canvas);

    const ctxAttribs: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    };
    const glContext = this.canvas.getContext("webgl2", ctxAttribs);
    if (!glContext) throw new Error("Aqualens: WebGL2 unavailable");
    this.gl = glContext;

    this._initGL();

    this.snapshotTarget = snapshotTarget;
    this._snapshotResolution = Math.max(0.1, Math.min(3.0, snapshotResolution));

    let lastScrollY = window.scrollY;
    let scrollTimeout: ReturnType<typeof setTimeout>;
    const scrollCheck = () => {
      if (this._destroyed) return;
      if (window.scrollY !== lastScrollY) {
        this._isScrolling = true;
        lastScrollY = window.scrollY;
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          this._isScrolling = false;
          if (this._resizePending) {
            this._resizePending = false;
            doResizeCapture(this);
          }
        }, 200);
        this.requestRender();
      }
      this._scrollCheckRafId = requestAnimationFrame(scrollCheck);
    };
    this._scrollCheckRafId = requestAnimationFrame(scrollCheck);

    this._onResizeHideHandler = () => {
      if (this._destroyed) return;
      if (this.canvas.style.opacity === "1") {
        this._resizeGeneration++;
        enableResizeFallback(this);
      }
    };
    window.addEventListener("resize", this._onResizeHideHandler, {
      passive: true,
    });

    this._onResizeHandler = debounce(() => {
      if (window.visualViewport && window.visualViewport.scale !== 1) {
        disableResizeFallback(this);
        return;
      }

      if (this._capturing || this._isScrolling) {
        this._resizePending = true;
        return;
      }

      this._resizePending = false;
      doResizeCapture(this);
    }, 250);
    window.addEventListener("resize", this._onResizeHandler, { passive: true });

    if ("ResizeObserver" in window) {
      this._resizeObserver = new ResizeObserver(this._onResizeHandler);
      this._resizeObserver.observe(this.snapshotTarget);
    }

    this._dynamicNodes = [];

    const styleElement = document.createElement("style");
    styleElement.id = "liquid-gl-dynamic-styles";
    document.head.appendChild(styleElement);
    this._dynamicStyleSheet = styleElement.sheet;

    resizeCanvas(this);

    this._pendingActivation = [];

    this._videoNodes = Array.from(
      this.snapshotTarget.querySelectorAll("video"),
    ).filter((video) => !isIgnored(video)) as HTMLVideoElement[];
    this._tmpCanvas = document.createElement("canvas");
    this._tmpCtx = this._tmpCanvas.getContext("2d")!;

    this.canvas.style.opacity = "0";

    this._workerEnabled =
      typeof OffscreenCanvas !== "undefined" &&
      typeof Worker !== "undefined" &&
      typeof ImageBitmap !== "undefined";

    if (this._workerEnabled) {
      const workerSrc = `
        self.onmessage = async (event) => {
          const { id, width, height, snap: snapshotBitmap, dyn: dynamicBitmap } = event.data;
          const offscreenCanvas = new OffscreenCanvas(width, height);
          const canvasContext = offscreenCanvas.getContext('2d');
          canvasContext.drawImage(snapshotBitmap, 0, 0, width, height);
          canvasContext.drawImage(dynamicBitmap, 0, 0, width, height);
          const bitmap = await offscreenCanvas.transferToImageBitmap();
          self.postMessage({ id, bmp: bitmap }, [bitmap]);
        };
      `;
      const blob = new Blob([workerSrc], { type: "application/javascript" });
      this._dynWorker = new Worker(URL.createObjectURL(blob), {
        type: "module",
      });
      this._dynJobs = new Map();

      this._dynWorker.onmessage = (event: MessageEvent) => {
        const { id: jobId, bmp } = event.data;
        const jobMeta = this._dynJobs!.get(jobId);
        if (!jobMeta) return;
        this._dynJobs!.delete(jobId);

        const { x, y } = jobMeta;
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          x,
          y,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bmp,
        );
      };
    }
  }

  private _initGL(): void {
    const gl = this.gl;

    this._hblurProgram = createProgramGL2(gl, VERTEX_SHADER, BLUR_H_FRAGMENT);
    this._vblurProgram = createProgramGL2(gl, VERTEX_SHADER, BLUR_V_FRAGMENT);
    this._mainProgram = createProgramGL2(gl, VERTEX_SHADER, MAIN_FRAGMENT);
    this._maskProgram = createProgramGL2(gl, VERTEX_SHADER, MASK_FRAGMENT);

    this._hblurU = this._getBlurUniforms(this._hblurProgram);
    this._vblurU = this._getBlurUniforms(this._vblurProgram);
    this._mainU = this._getMainUniforms(this._mainProgram);
    this._maskU = this._getMaskUniforms(this._maskProgram);

    this._compositeProgram = createProgramGL2(
      gl,
      VERTEX_SHADER,
      COMPOSITE_FRAGMENT,
    );
    this._compositeU = {
      src: gl.getUniformLocation(this._compositeProgram, "u_src"),
      srcRegion: gl.getUniformLocation(this._compositeProgram, "u_srcRegion"),
    };

    const vertexArrayObject = gl.createVertexArray()!;
    gl.bindVertexArray(vertexArrayObject);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this._vao = vertexArrayObject;
  }

  private _getBlurUniforms(program: WebGLProgram): BlurUniforms {
    const gl = this.gl;
    return {
      inputTex: gl.getUniformLocation(program, "u_inputTex"),
      texSize: gl.getUniformLocation(program, "u_texSize"),
      blurRadius: gl.getUniformLocation(program, "u_blurRadius"),
      blurWeights: gl.getUniformLocation(program, "u_blurWeights"),
    };
  }

  private _getMaskUniforms(program: WebGLProgram): MaskUniforms {
    const gl = this.gl;
    return {
      resolution: gl.getUniformLocation(program, "u_resolution"),
      dpr: gl.getUniformLocation(program, "u_dpr"),
      radius: gl.getUniformLocation(program, "u_radius"),
      radiusCorners: gl.getUniformLocation(program, "u_radiusCorners"),
      shapeCount: gl.getUniformLocation(program, "u_shapeCount"),
      mergeK: gl.getUniformLocation(program, "u_mergeK"),
      shapes: gl.getUniformLocation(program, "u_shapes"),
    };
  }

  private _getMainUniforms(program: WebGLProgram): MainUniforms {
    const gl = this.gl;
    return {
      tex: gl.getUniformLocation(program, "u_tex"),
      blurredTex: gl.getUniformLocation(program, "u_blurredTex"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      dpr: gl.getUniformLocation(program, "u_dpr"),
      bounds: gl.getUniformLocation(program, "u_bounds"),
      texSize: gl.getUniformLocation(program, "u_texSize"),
      radius: gl.getUniformLocation(program, "u_radius"),
      radiusCorners: gl.getUniformLocation(program, "u_radiusCorners"),
      refThickness: gl.getUniformLocation(program, "u_refThickness"),
      refFactor: gl.getUniformLocation(program, "u_refFactor"),
      refDispersion: gl.getUniformLocation(program, "u_refDispersion"),
      refFresnelRange: gl.getUniformLocation(program, "u_refFresnelRange"),
      refFresnelHardness: gl.getUniformLocation(
        program,
        "u_refFresnelHardness",
      ),
      refFresnelFactor: gl.getUniformLocation(program, "u_refFresnelFactor"),
      glareRange: gl.getUniformLocation(program, "u_glareRange"),
      glareHardness: gl.getUniformLocation(program, "u_glareHardness"),
      glareFactor: gl.getUniformLocation(program, "u_glareFactor"),
      glareConvergence: gl.getUniformLocation(program, "u_glareConvergence"),
      glareOppositeFactor: gl.getUniformLocation(
        program,
        "u_glareOppositeFactor",
      ),
      glareAngle: gl.getUniformLocation(program, "u_glareAngle"),
      blurEdge: gl.getUniformLocation(program, "u_blurEdge"),
      tint: gl.getUniformLocation(program, "u_tint"),
      shapeCount: gl.getUniformLocation(program, "u_shapeCount"),
      mergeK: gl.getUniformLocation(program, "u_mergeK"),
      shapes: gl.getUniformLocation(program, "u_shapes"),
      shadowShapes: gl.getUniformLocation(program, "u_shadowShapes"),
      blurAmount: gl.getUniformLocation(program, "u_blurAmount"),
      shapeMaterials: gl.getUniformLocation(program, "u_shapeMaterials"),
    };
  }

  // ------------------------------------------------------------------
  //  Render
  // ------------------------------------------------------------------

  render(): void {
    if (this._destroyed) return;
    const gl = this.gl;
    if (!this.texture) return;

    if (this._isScrolling) {
      this._scrollUpdateCounter++;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    updateDynamicVideos(this);
    updateDynamicNodes(this);

    updateBlurKernel(this);
    ensureBlurFBOs(this);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const visualViewport = window.visualViewport;
    const viewportWidth = visualViewport?.width ?? innerWidth;
    const viewportHeight = visualViewport?.height ?? innerHeight;
    const overscrollX = visualViewport?.offsetLeft ?? 0;
    const overscrollY = visualViewport?.offsetTop ?? 0;
    const snapRect = this.snapshotTarget.getBoundingClientRect();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const lens of this.lenses) {
      lens.updateMetrics();
    }

    const zGroups = new Map<number, AqualensLens[]>();
    for (const lens of this.lenses) {
      const zIndex = effectiveZ(lens.element);
      let group = zGroups.get(zIndex);
      if (!group) {
        group = [];
        zGroups.set(zIndex, group);
      }
      group.push(lens);
    }

    const sortedZ = Array.from(zGroups.keys()).sort(
      (aIndex, bIndex) => aIndex - bIndex,
    );

    const needCascade = sortedZ.length > 1;
    const opaqueCascade = needCascade && this.opaqueOverlap;

    if (needCascade && !opaqueCascade) {
      ensureComposeFbo(this);
      copyToCompose(this);
    }

    if (!needCascade || opaqueCascade) {
      if (this._currentBlurRadius > 0) runBlurPasses(this);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    for (let zIndex = 0; zIndex < sortedZ.length; zIndex++) {
      const currentZ = sortedZ[zIndex];
      const group = zGroups.get(currentZ)!;

      if (needCascade && !opaqueCascade) {
        this._activeSourceTex = this._composeTex;
        gl.disable(gl.BLEND);
        if (this._currentBlurRadius > 0) runBlurPasses(this, this._composeTex!);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      const visible = group.filter((lens) => {
        const rect = lens.rectPx;
        if (!rect || rect.width < 2 || rect.height < 2) return false;
        return (
          rect.left + rect.width > 0 &&
          rect.left < viewportWidth &&
          rect.top + rect.height > 0 &&
          rect.top < viewportHeight
        );
      });

      if (opaqueCascade && zIndex > 0 && visible.length > 0) {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.ZERO,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ZERO,
          gl.ONE_MINUS_SRC_ALPHA,
        );
        renderGroupMask(
          this,
          visible,
          dpr,
          snapRect,
          overscrollX,
          overscrollY,
        );
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      if (visible.length === 1) {
        renderLens(this, visible[0], dpr, snapRect, overscrollX, overscrollY);
      } else if (visible.length > 1) {
        renderMergedGroup(
          this,
          visible,
          dpr,
          snapRect,
          overscrollX,
          overscrollY,
        );
      }

      if (needCascade && !opaqueCascade && zIndex < sortedZ.length - 1) {
        flattenGroupToCompose(this, visible, dpr);
      }
    }

    this._activeSourceTex = null;
    gl.disable(gl.BLEND);
  }

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------

  addLens(element: HTMLElement, options: AqualensConfig): AqualensLens {
    const lens = new AqualensLens(this, element, options);
    this.lenses.push(lens);

    if (!this.texture) {
      this._pendingActivation.push(lens);
    } else {
      lens._activate();
    }
    this.requestRender();
    return lens;
  }

  removeLens(lens: AqualensLens): void {
    const index = this.lenses.indexOf(lens);
    if (index !== -1) {
      this.lenses.splice(index, 1);
    }
    this.requestRender();
  }

  async captureSnapshot(): Promise<boolean> {
    return captureSnapshotImpl(this);
  }

  setSnapshotTarget(element: HTMLElement): void {
    if (this._destroyed || this.snapshotTarget === element) return;
    this._resizeObserver?.disconnect();
    this.snapshotTarget = element;
    if ("ResizeObserver" in window && this._resizeObserver) {
      this._resizeObserver.observe(this.snapshotTarget);
    }
    this._videoNodes = Array.from(
      this.snapshotTarget.querySelectorAll("video"),
    ).filter((video) => !isIgnored(video)) as HTMLVideoElement[];
  }

  setResolution(value: number): void {
    if (this._destroyed) return;
    const next = Math.max(0.1, Math.min(3.0, value));
    if (this._snapshotResolution === next) return;
    this._snapshotResolution = next;
  }

  addDynamicElement(
    element: HTMLElement | HTMLElement[] | NodeList | string,
  ): void {
    addDynamicElementImpl(this, element);
  }

  // ------------------------------------------------------------------
  //  Render loop & lifecycle
  // ------------------------------------------------------------------

  requestRender(): void {
    if (this._destroyed) return;
    this._invalidated = true;
    if (!this._rafId && !this.useExternalTicker) this._scheduleRenderLoop();
  }

  private _shouldKeepLoopRunning(): boolean {
    if (this._invalidated || this._isScrolling) return true;
    if (this._pendingActivation.length > 0) return true;
    if (this._videoNodes.some((video) => !video.paused)) return true;
    for (let index = 0; index < this._dynamicNodes.length; index++) {
      const dynamicMeta = this._dynMeta.get(this._dynamicNodes[index].element);
      if (dynamicMeta && dynamicMeta._animating) return true;
    }
    return false;
  }

  private _scheduleRenderLoop(): void {
    if (this._rafId || this.useExternalTicker) return;
    const loop = () => {
      this.render();
      this._invalidated = false;
      if (this._shouldKeepLoopRunning()) {
        this._rafId = requestAnimationFrame(loop);
      } else {
        this._rafId = null;
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  startRenderLoop(): void {
    if (this._rafId || this.useExternalTicker) return;
    this._invalidated = true;
    this._scheduleRenderLoop();
  }

  stopRenderLoop(): void {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.stopRenderLoop();
    if (this._scrollCheckRafId) {
      cancelAnimationFrame(this._scrollCheckRafId);
    }
    if (this._dynamicRemovalRaf) {
      cancelAnimationFrame(this._dynamicRemovalRaf);
      this._dynamicRemovalRaf = null;
    }
    this._dynamicRemovalObserver?.disconnect();
    this._dynamicRemovalObserver = null;
    disableResizeFallback(this);
    window.removeEventListener("resize", this._onResizeHideHandler);
    window.removeEventListener("resize", this._onResizeHandler);
    this._resizeObserver?.disconnect();
    this.lenses.forEach((lens) => lens.destroy());
    this.lenses.length = 0;
    if (this._dynWorker) {
      this._dynWorker.terminate();
    }
    destroyBlurFBOs(this);
    destroyComposeFbo(this);
    this.canvas.remove();
    const styleElement = document.getElementById("liquid-gl-dynamic-styles");
    styleElement?.remove();
  }
}
