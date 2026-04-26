import {
  VERTEX_SHADER,
  KAWASE_DOWN_FRAGMENT,
  KAWASE_UP_FRAGMENT,
  COMPOSITE_FRAGMENT,
  MAIN_FRAGMENT,
  MASK_FRAGMENT,
  REVEAL_MASKED_FRAGMENT,
} from "./shaders";
import { debounce } from "./utils";
import type { AqualensConfig, AqualensRendererInstance } from "./types";
import { AqualensLens } from "./lens";
import {
  createProgramGL2,
  type DynMeta,
  type KawaseUniforms,
  type BlurPyramidLevel,
  type MainUniforms,
  type MaskUniforms,
  type RevealMaskedUniforms,
} from "./gl-utils";
import {
  ensureBlurPyramid,
  destroyBlurPyramid,
  updateBlurConfig,
  ensureComposeFbo,
  destroyComposeFbo,
  copyToCompose,
  runKawaseBlur,
  flattenGroupToCompose,
  compositeLensContentToCompose,
  copyLensRegionsToPublicCanvases,
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
  computeMergedGroupLayout,
  computeSingleLensViewport,
} from "./renderer-draw";
import {
  updateDynamicVideos,
  updateDynamicNodes,
  addDynamicElementImpl,
  isIgnored,
  triggerLensContentCaptures,
} from "./renderer-dynamic";
import {
  buildMergedGroupShapes,
  buildSingleLensShape,
  compositeRevealsForStackingIndex,
  compositeRevealsOnLensForGroup,
  destroyRevealResources,
  discoverReveals,
  hasEligibleReveals,
  hasEligibleUnderLensReveals,
  REVEAL_CSS_SELECTOR,
  REVEAL_OBSERVED_ATTRS,
  triggerRevealCaptures,
  type RevealMeta,
} from "./renderer-reveal";

// NOTE: we intentionally avoid `visibility: hidden` here.
// html2canvas-pro serializes SVG descendants via XMLSerializer into a
// `data:image/svg+xml,...` URL and renders them as standalone images, so any
// CSS rule from the cloned document does NOT apply to those SVGs — only inline
// styles copied onto the SVG clone do. Because `copyCSSStyles` inlines the full
// computed style of every SVG clone BEFORE onclone runs, and `visibility`
// inherits, a `visibility: hidden` on the reveal container bakes `visibility:
// hidden` as an inline attribute on every SVG descendant, making them render
// invisibly inside the reveal capture.
// `opacity` is not inherited in the CSS sense (each element computes its own),
// so children end up with `opacity: 1` in their computed style, which is safe
// to inline. Visually, the parent's `opacity: 0` still cascades through
// compositing to hide the whole subtree on the live page, and
// `pointer-events: none` prevents interaction (inherited by children).
const DYNAMIC_STYLES_CSS = `
html:not([data-liquid-power-save="true"]) ${REVEAL_CSS_SELECTOR} {
  opacity: 0 !important;
  pointer-events: none !important;
}
`;

export class AqualensRenderer implements AqualensRendererInstance {
  /**
   * Private offscreen canvas hosting the WebGL2 context. NOT inserted into
   * the DOM — the only thing the user ever sees is each lens's own
   * `publicCanvas` (a child of the lens DOM element). After each lens
   * group is rendered into this private canvas, the relevant regions are
   * copied into the corresponding public canvases via `drawImage`.
   *
   * Keeping the private canvas at full viewport size lets the
   * `renderer-draw` viewport code keep using `canvas.height` for
   * GL-coordinate conversions without changes.
   */
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  lenses: AqualensLens[] = [];
  /**
   * When true and lenses use different stackingIndex values, higher layers
   * clip lower ones and each lens samples the original snapshot
   * (macOS-style overlap).
   */
  opaqueOverlap = false;
  texture: WebGLTexture | null = null;
  textureWidth = 0;
  textureHeight = 0;
  scaleFactor = 1;
  useExternalTicker = false;

  _kawaseDownProgram!: WebGLProgram;
  _kawaseUpProgram!: WebGLProgram;
  _mainProgram!: WebGLProgram;
  _maskProgram!: WebGLProgram;
  _kawaseDownU!: KawaseUniforms;
  _kawaseUpU!: KawaseUniforms;
  _mainU!: MainUniforms;
  _maskU!: MaskUniforms;
  _vao!: WebGLVertexArrayObject;

  _blurPyramid: BlurPyramidLevel[] = [];
  _blurResultTex: WebGLTexture | null = null;
  _currentBlurRadius = 0;
  _blurLevelCount = 0;

  _textureVersion = 0;
  _blurredForTextureVersion = -1;
  _blurredForRadius = -1;

  _composeFbo: WebGLFramebuffer | null = null;
  _composeTex: WebGLTexture | null = null;
  _composeFboW = 0;
  _composeFboH = 0;
  _srcReadFbo: WebGLFramebuffer | null = null;
  _canvasCopyTex: WebGLTexture | null = null;
  _canvasCopyTexW = 0;
  _canvasCopyTexH = 0;

  /** Texture used to upload `lens._contentCapture` into the compose FBO. */
  _lensContentTex: WebGLTexture | null = null;
  _lensContentTexW = 0;
  _lensContentTexH = 0;
  _lensContentRecaptureInFlight = 0;
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
  readonly _onScrollHandler: () => void;
  _resizeFallbackActive = false;
  _resizeFallbackCleanups: (() => void)[] = [];
  _resizeGeneration = 0;
  _resizePending = false;
  readonly _resizeObserver?: ResizeObserver;
  _destroyed = false;

  _scratchShapeData = new Float32Array(MAX_SHAPES * 2 * 4);
  _scratchShadowShapes = new Float32Array(MAX_SHAPES * 2 * 4);
  _scratchMaterialData = new Float32Array(MAX_SHAPES * 4 * 4);

  _zGroupMap = new Map<number, AqualensLens[]>();
  _sortedZKeys: number[] = [];
  _implicitScratch: AqualensLens[] = [];
  _singleGroupScratch: AqualensLens[] = [];
  _visibleScratch: AqualensLens[] = [];
  /**
   * Set of lenses whose `publicCanvas` has been (re)painted in the
   * current `render()` pass. After the per-group loop finishes, every
   * lens NOT in this set is reset to its own single-lens region so
   * stale merged-bbox pixels (left over from a previous frame where
   * the lens was part of a merged group) cannot leak into the viewport
   * via the canvas's negative offsets.
   */
  _renderedLensesScratch = new Set<AqualensLens>();

  _revealNodes: RevealMeta[] = [];
  _revealComposited = new Set<RevealMeta>();
  _revealCaptureInFlight = 0;
  _revealUploadTex: WebGLTexture | null = null;
  _revealUploadTexW = 0;
  _revealUploadTexH = 0;
  _revealObserver: MutationObserver | null = null;
  _revealDiscoveryScheduled = false;
  _revealMaskedProgram!: WebGLProgram;
  _revealMaskedU!: RevealMaskedUniforms;

  constructor(snapshotTarget: HTMLElement, snapshotResolution = 1.0) {
    // Offscreen canvas: NOT appended to DOM. The only canvases the user
    // ever sees are the per-lens `publicCanvas` siblings created by
    // `AqualensLens`.
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("data-liquid-ignore", "");

    const ctxAttribs: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      // Required: lens public canvases sample our private WebGL canvas
      // via `ctx.drawImage(privateCanvas, ...)` AFTER WebGL has rendered
      // each group. Without `preserveDrawingBuffer`, the browser is
      // allowed to discard the backing buffer between draw and read,
      // which produces empty / stale public canvases.
      preserveDrawingBuffer: true,
    };
    const glContext = this.canvas.getContext("webgl2", ctxAttribs);
    if (!glContext) throw new Error("Aqualens: WebGL2 unavailable");
    this.gl = glContext;

    this._initGL();

    this.snapshotTarget = snapshotTarget;
    this._snapshotResolution = Math.max(0.1, Math.min(3.0, snapshotResolution));

    let scrollTimeout: ReturnType<typeof setTimeout>;
    this._onScrollHandler = () => {
      if (this._destroyed) return;
      this._isScrolling = true;
      for (const lens of this.lenses) lens._rectDirty = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this._isScrolling = false;
        for (const lens of this.lenses) lens._rectDirty = true;
        if (this._resizePending) {
          this._resizePending = false;
          doResizeCapture(this);
        }
      }, 200);
      this.requestRender();
    };
    window.addEventListener("scroll", this._onScrollHandler, { passive: true });

    this._onResizeHideHandler = () => {
      if (this._destroyed) return;
      enableResizeFallback(this);
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
    styleElement.textContent = DYNAMIC_STYLES_CSS;
    document.head.appendChild(styleElement);
    this._dynamicStyleSheet = styleElement.sheet;

    this._installRevealObserver();

    resizeCanvas(this);

    this._pendingActivation = [];

    this._videoNodes = Array.from(
      this.snapshotTarget.querySelectorAll("video"),
    ).filter((video) => !isIgnored(video)) as HTMLVideoElement[];
    this._tmpCanvas = document.createElement("canvas");
    this._tmpCtx = this._tmpCanvas.getContext("2d")!;

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
        this._textureVersion++;
      };
    }
  }

  private _initGL(): void {
    const gl = this.gl;

    this._kawaseDownProgram = createProgramGL2(
      gl,
      VERTEX_SHADER,
      KAWASE_DOWN_FRAGMENT,
    );
    this._kawaseUpProgram = createProgramGL2(
      gl,
      VERTEX_SHADER,
      KAWASE_UP_FRAGMENT,
    );
    this._mainProgram = createProgramGL2(gl, VERTEX_SHADER, MAIN_FRAGMENT);
    this._maskProgram = createProgramGL2(gl, VERTEX_SHADER, MASK_FRAGMENT);

    this._kawaseDownU = this._getKawaseUniforms(this._kawaseDownProgram);
    this._kawaseUpU = this._getKawaseUniforms(this._kawaseUpProgram);
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

    this._revealMaskedProgram = createProgramGL2(
      gl,
      VERTEX_SHADER,
      REVEAL_MASKED_FRAGMENT,
    );
    this._revealMaskedU = {
      resolution: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_resolution",
      ),
      dpr: gl.getUniformLocation(this._revealMaskedProgram, "u_dpr"),
      radius: gl.getUniformLocation(this._revealMaskedProgram, "u_radius"),
      radiusCorners: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_radiusCorners",
      ),
      shapeCount: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_shapeCount",
      ),
      mergeK: gl.getUniformLocation(this._revealMaskedProgram, "u_mergeK"),
      shapes: gl.getUniformLocation(this._revealMaskedProgram, "u_shapes"),
      reveal: gl.getUniformLocation(this._revealMaskedProgram, "u_reveal"),
      revealRegion: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_revealRegion",
      ),
      revealRect: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_revealRect",
      ),
      refThickness: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_refThickness",
      ),
      refFactor: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_refFactor",
      ),
      refDispersion: gl.getUniformLocation(
        this._revealMaskedProgram,
        "u_refDispersion",
      ),
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

  private _getKawaseUniforms(program: WebGLProgram): KawaseUniforms {
    const gl = this.gl;
    return {
      tex: gl.getUniformLocation(program, "u_tex"),
      halfPixel: gl.getUniformLocation(program, "u_halfPixel"),
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

    updateDynamicVideos(this);
    updateDynamicNodes(this);

    updateBlurConfig(this);
    ensureBlurPyramid(this);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const visualViewport = window.visualViewport;
    const viewportWidth = visualViewport?.width ?? innerWidth;
    const viewportHeight = visualViewport?.height ?? innerHeight;
    const overscrollX = visualViewport?.offsetLeft ?? 0;
    const overscrollY = visualViewport?.offsetTop ?? 0;
    const snapRect = this.snapshotTarget.getBoundingClientRect();

    // Group lenses BEFORE updating metrics: tint mode (CSS vs WebGL) depends
    // on stacking-group membership, and the metrics step in turn re-reads CSS
    // background-color whose handling differs per mode.
    const implicitLenses = this._implicitScratch;
    implicitLenses.length = 0;

    const explicitGroups = this._zGroupMap;
    for (const [, group] of explicitGroups) group.length = 0;

    for (const lens of this.lenses) {
      if (lens.options.stackingIndex !== undefined) {
        const si = lens.options.stackingIndex;
        let group = explicitGroups.get(si);
        if (!group) {
          group = [];
          explicitGroups.set(si, group);
        }
        group.push(lens);
      } else {
        implicitLenses.push(lens);
      }
    }

    const sortedExplicitKeys = this._sortedZKeys;
    sortedExplicitKeys.length = 0;
    for (const key of explicitGroups.keys()) {
      if (explicitGroups.get(key)!.length > 0) sortedExplicitKeys.push(key);
    }
    sortedExplicitKeys.sort((a, b) => a - b);

    const implicitCount = implicitLenses.length;
    const totalGroups = implicitCount + sortedExplicitKeys.length;
    const hasMultipleGroups = totalGroups > 1;
    const opaqueCascade = hasMultipleGroups && this.opaqueOverlap;
    const cascadeActive = hasMultipleGroups && !opaqueCascade;

    for (const lens of this.lenses) {
      lens.updateMetrics();
    }

    const revealsActive = hasEligibleReveals(this);
    if (revealsActive) triggerRevealCaptures(this);
    const underLensRevealsActive = hasEligibleUnderLensReveals(this);

    // Compose FBO is needed when:
    //  - there are >1 stacking groups (cascade): later groups must sample
    //    the already-rendered earlier groups + their DOM content;
    //  - there are under-lens reveals: their captured pixels must be
    //    pre-baked into the source texture.
    const useCompose = cascadeActive || underLensRevealsActive;
    this._revealComposited.clear();

    if (useCompose) {
      ensureComposeFbo(this);
      copyToCompose(this);
      // Cascade requires html2canvas snapshots of every lens's DOM content
      // so we can paint it into the compose FBO between groups (so a
      // higher-z lens refracts the lower-z lens AND its DOM content).
      if (cascadeActive) triggerLensContentCaptures(this);
    }

    const blurStale =
      this._blurredForTextureVersion !== this._textureVersion ||
      this._blurredForRadius !== this._currentBlurRadius;
    if (
      this._currentBlurRadius > 0 &&
      (blurStale || cascadeActive || useCompose)
    ) {
      runKawaseBlur(
        this,
        useCompose ? this._composeTex ?? undefined : undefined,
      );
      this._blurredForTextureVersion = this._textureVersion;
      this._blurredForRadius = this._currentBlurRadius;
    }

    // Start with a clean private canvas so previous-frame artefacts do
    // not leak into the per-lens drawImage copies below.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const singleGroup = this._singleGroupScratch;
    const renderedLenses = this._renderedLensesScratch;
    renderedLenses.clear();

    for (let groupIdx = 0; groupIdx < totalGroups; groupIdx++) {
      let group: AqualensLens[];

      if (groupIdx < implicitCount) {
        singleGroup[0] = implicitLenses[groupIdx];
        singleGroup.length = 1;
        group = singleGroup;
      } else {
        const ek = sortedExplicitKeys[groupIdx - implicitCount];
        group = explicitGroups.get(ek)!;
      }

      // Pick the source texture for this group's refraction sampling.
      // When cascade or under-lens reveals are active, every group
      // samples the compose FBO. Compose holds (snapshot + earlier
      // groups' glass output + their DOM content) at this point.
      this._activeSourceTex = useCompose ? this._composeTex : null;

      const explicitKey =
        groupIdx >= implicitCount
          ? sortedExplicitKeys[groupIdx - implicitCount]
          : undefined;

      if (underLensRevealsActive && explicitKey !== undefined) {
        const addedReveals = compositeRevealsForStackingIndex(
          this,
          explicitKey,
          snapRect,
        );
        if (addedReveals && this._currentBlurRadius > 0 && this._composeTex) {
          runKawaseBlur(this, this._composeTex);
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      const visible = this._visibleScratch;
      visible.length = 0;
      for (let li = 0; li < group.length; li++) {
        const lens = group[li];
        const rect = lens.rectPx;
        if (!rect || rect.width < 2 || rect.height < 2) continue;
        if (
          rect.left + rect.width > 0 &&
          rect.left < viewportWidth &&
          rect.top + rect.height > 0 &&
          rect.top < viewportHeight
        ) {
          visible.push(lens);
        }
      }

      if (opaqueCascade && groupIdx > 0 && visible.length > 0) {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.ZERO,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ZERO,
          gl.ONE_MINUS_SRC_ALPHA,
        );
        renderGroupMask(this, visible, dpr, snapRect, overscrollX, overscrollY);
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

      // Cascade: prepare the compose FBO for the NEXT group BEFORE we
      // touch the private canvas with `drawImage` reads (which can
      // invalidate the WebGL backing buffer in some browsers). We want
      // compose to hold (snapshot + all earlier groups' glass output +
      // their DOM content), so:
      //   1. blit the just-rendered private-canvas region into compose,
      //   2. paint the lens's html2canvas DOM-content snapshot on top
      //      (so a higher-z lens refracts both the glass and the lens
      //      contents below it),
      //   3. blur compose so the next group's blur sample is in sync.
      if (cascadeActive && groupIdx < totalGroups - 1) {
        flattenGroupToCompose(this, visible, dpr);
        compositeLensContentToCompose(this, visible, snapRect);
        if (this._currentBlurRadius > 0 && this._composeTex) {
          runKawaseBlur(this, this._composeTex);
        }
      }

      // On-lens reveals: paint any eligible on-lens reveals directly on
      // the default framebuffer, clipped by this group's SDF. Running
      // AFTER `flattenGroupToCompose` keeps the on-lens overlay out of
      // the next group's compose source, so it doesn't propagate
      // through higher lenses.
      if (revealsActive && explicitKey !== undefined && visible.length > 0) {
        this._compositeOnLensRevealsForVisibleGroup(
          visible,
          explicitKey,
          dpr,
          overscrollX,
          overscrollY,
        );
      }

      // Copy the freshly rendered region of the private canvas into the
      // public canvas of every lens in this group. This is the moment
      // where the WebGL output becomes user-visible. MUST happen AFTER
      // the cascade-prep step above, because some browsers invalidate
      // the WebGL backing buffer once it has been read via `drawImage`.
      if (visible.length > 0) {
        copyLensRegionsToPublicCanvases(this, visible, dpr);
        for (let li = 0; li < visible.length; li++) {
          renderedLenses.add(visible[li]);
        }
      }

      // Clear the private canvas before the next group renders. This
      // prevents the next group's `drawImage` (when its public-canvas
      // region overlaps with this one's) from picking up this group's
      // pixels. Re-bind the default FB explicitly — at this point we
      // could still be bound to compose / a blur level after the
      // cascade-prep work above.
      if (groupIdx < totalGroups - 1) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    // Reset per-lens public canvases that were NOT repainted in this
    // frame back to their own single-lens region (lens rect + shadow
    // pad). When a lens leaves a merged group — either because its
    // siblings scrolled off-screen, or because it itself went off-screen
    // — its canvas would otherwise stay sized to the previous frame's
    // union bbox and keep stale merged-blob pixels. Because the canvas
    // is positioned absolutely inside the lens with negative offsets
    // that span the bbox, those pixels can intrude into the viewport
    // long after the lens itself has scrolled away (visible as a
    // "ghost" of the merged blob a screen later). Resyncing to the
    // lens's own rect both clamps the canvas back inside the lens and
    // discards the stale buffer when dimensions actually shrink.
    for (let li = 0; li < this.lenses.length; li++) {
      const lens = this.lenses[li];
      if (renderedLenses.has(lens)) continue;
      lens._syncPublicCanvasSize();
    }

    this._activeSourceTex = null;
    gl.disable(gl.BLEND);
  }

  /**
   * Shared entry point for `on-lens` reveal compositing: computes the same
   * viewport / SDF shape data the main lens render pass used, then delegates
   * to {@link compositeRevealsOnLensForGroup}.
   */
  private _compositeOnLensRevealsForVisibleGroup(
    visible: AqualensLens[],
    stackingIndex: number,
    dpr: number,
    overscrollX: number,
    overscrollY: number,
  ): void {
    // Early-out: no on-lens reveals reachable at this stacking index.
    let anyOnLens = false;
    for (const reveal of this._revealNodes) {
      if (reveal.mode !== "on-lens") continue;
      if (reveal.revealValue > stackingIndex) continue;
      if (!reveal.capture) continue;
      anyOnLens = true;
      break;
    }
    if (!anyOnLens) return;

    if (visible.length === 1) {
      const lens = visible[0];
      const viewportData = computeSingleLensViewport(
        lens,
        dpr,
        overscrollX,
        overscrollY,
        this.canvas.height,
      );
      if (!viewportData) return;
      const { viewport, shadowPad } = viewportData;
      const shape = buildSingleLensShape(lens, dpr, shadowPad);
      if (!shape) return;
      compositeRevealsOnLensForGroup(
        this,
        stackingIndex,
        [shape],
        0,
        lens.options.refraction,
        viewport.viewportX,
        viewport.viewportY,
        viewport.viewportWidth,
        viewport.viewportHeight,
        viewport.viewportLeft,
        viewport.viewportTop,
        viewport.viewportWidthPx,
        viewport.viewportHeightPx,
        dpr,
      );
      return;
    }

    // Merged group viewport (matches renderMergedGroup). For > MAX_SHAPES
    // lenses renderMergedGroup splits into smaller batches; we mirror that
    // here to keep the SDF shape set consistent with what was drawn.
    const chunkSize = MAX_SHAPES;
    let offset = 0;
    while (offset < visible.length) {
      const chunk = visible.slice(offset, offset + chunkSize);
      offset += chunkSize;
      if (chunk.length === 1) {
        const viewportData = computeSingleLensViewport(
          chunk[0],
          dpr,
          overscrollX,
          overscrollY,
          this.canvas.height,
        );
        if (!viewportData) continue;
        const { viewport, shadowPad } = viewportData;
        const shape = buildSingleLensShape(chunk[0], dpr, shadowPad);
        if (!shape) continue;
        compositeRevealsOnLensForGroup(
          this,
          stackingIndex,
          [shape],
          0,
          chunk[0].options.refraction,
          viewport.viewportX,
          viewport.viewportY,
          viewport.viewportWidth,
          viewport.viewportHeight,
          viewport.viewportLeft,
          viewport.viewportTop,
          viewport.viewportWidthPx,
          viewport.viewportHeightPx,
          dpr,
        );
        continue;
      }
      const layout = computeMergedGroupLayout(
        chunk,
        dpr,
        overscrollX,
        overscrollY,
        this.canvas.height,
      );
      if (!layout) continue;
      const shapes = buildMergedGroupShapes(
        chunk,
        dpr,
        layout.unionLeft,
        layout.unionBottom,
      );
      // Merged group: take refraction params from the first lens in the
      // chunk. See RevealRefraction's doc-comment for why we don't try to
      // blend them per-shape.
      compositeRevealsOnLensForGroup(
        this,
        stackingIndex,
        shapes,
        layout.mergeSmoothness,
        chunk[0].options.refraction,
        layout.viewport.viewportX,
        layout.viewport.viewportY,
        layout.viewport.viewportWidth,
        layout.viewport.viewportHeight,
        layout.viewport.viewportLeft,
        layout.viewport.viewportTop,
        layout.viewport.viewportWidthPx,
        layout.viewport.viewportHeightPx,
        dpr,
      );
    }
  }

  private _installRevealObserver(): void {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((mutations) => {
      let shouldSync = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          if (
            mutation.addedNodes.length > 0 ||
            mutation.removedNodes.length > 0
          ) {
            shouldSync = true;
            break;
          }
        } else if (
          mutation.type === "attributes" &&
          mutation.attributeName !== null &&
          REVEAL_OBSERVED_ATTRS.includes(mutation.attributeName)
        ) {
          shouldSync = true;
          break;
        }
      }
      if (!shouldSync) return;
      this._scheduleRevealDiscovery();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...REVEAL_OBSERVED_ATTRS],
    });
    this._revealObserver = observer;
  }

  private _scheduleRevealDiscovery(): void {
    if (this._revealDiscoveryScheduled || this._destroyed) return;
    this._revealDiscoveryScheduled = true;
    const run = () => {
      this._revealDiscoveryScheduled = false;
      if (this._destroyed) return;
      discoverReveals(this);
      triggerRevealCaptures(this);
      this.requestRender();
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
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
    window.removeEventListener("scroll", this._onScrollHandler);
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
    destroyBlurPyramid(this);
    destroyComposeFbo(this);
    destroyRevealResources(this);
    if (this._revealObserver) {
      this._revealObserver.disconnect();
      this._revealObserver = null;
    }
    if (this._lensContentTex) {
      this.gl.deleteTexture(this._lensContentTex);
      this._lensContentTex = null;
    }
    const styleElement = document.getElementById("liquid-gl-dynamic-styles");
    styleElement?.remove();
  }
}
