import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  forwardRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import {
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
  getSharedPowerSaveRenderer,
  getSharedSvgRenderer,
  setSvgOpaqueOverlap,
  supportsSvgBackdropFilter,
  DEFAULT_OPTIONS,
  LENS_DOM_ATTR,
  type AqualensRenderer,
  type AqualensLensInstance,
  type AqualensConfig,
  type PowerSaveRenderer,
  type SvgRenderer,
  type RefractionOptions,
  type GlareOptions,
  type SnapshotSourceElement,
  type SnapshotSourceTexture,
  type SnapshotSourceTextureSize,
  type RenderMode,
  type SurfaceShape,
} from "@aqualens/core";

interface AqualensOwnProps {
  children?: ReactNode;
  /** Target element for the snapshot background. */
  snapshotTarget?: HTMLElement | null;
  /** Render resolution multiplier (0.1–3.0). @default 2.0 */
  resolution?: number;
  /** Optional known source element used instead of html2canvas. */
  sourceElement?: SnapshotSourceElement | null;
  /** Optional texture source uploaded directly to WebGL. */
  sourceTexture?: SnapshotSourceTexture | null;
  /** Optional explicit size for `sourceTexture`. */
  sourceTextureSize?: SnapshotSourceTextureSize;

  /** Refraction (distortion) parameters. */
  refraction?: RefractionOptions;
  /** Glare (specular highlight) parameters. */
  glare?: GlareOptions;

  /** Gaussian blur radius in pixels. @default 1 */
  blurRadius?: number;
  /** Clip blur at element edges. @default true */
  blurEdge?: boolean;

  /**
   * Explicit stacking index that controls lens merge grouping and overlay priority.
   * Lenses with the same stackingIndex merge together in `webgl` mode; higher
   * values render on top. When omitted, the lens is rendered individually in
   * natural DOM order and always below any lens that has an explicit
   * stackingIndex.
   *
   * Note: the `svg` backend never merges sibling lenses into a shared blob —
   * use `mode="webgl"` if you need true multi-lens merging.
   */
  stackingIndex?: number;

  /**
   * When true, lenses at different stackingIndex values clip lower ones and sample
   * the original snapshot (macOS-style). Supported by both `webgl` and `svg`
   * backends. Ignored by `css`.
   * @default false
   */
  opaqueOverlap?: boolean;

  /**
   * Rendering backend. Defaults to `auto`, which picks `svg` on Chromium-based
   * browsers (cheap GPU compositing via SVG-as-`backdrop-filter`) and `webgl`
   * everywhere else. Use `css` for the lightest-weight fallback. Supersedes
   * the legacy `powerSave` boolean (`powerSave: true` is treated as
   * `mode: "css"`).
   * @default "auto"
   */
  mode?: RenderMode;

  /**
   * Bezel surface profile used by the SVG backend. Apple's Liquid Glass
   * mostly uses `convex-squircle`. Ignored by other modes.
   * @default "convex-squircle"
   */
  surfaceShape?: SurfaceShape;

  /**
   * Refractive index passed to Snell's law in the SVG backend. Ignored by
   * other modes. Default of 1.5 matches plain glass and the kube.io article.
   * @default 1.5
   */
  refractiveIndex?: number;

  /**
   * @deprecated Use `mode="css"` instead. Kept for backward compatibility:
   * `powerSave: true` is treated as `mode: "css"`.
   */
  powerSave?: boolean;

  /** Called once after the lens is initialized. */
  onInit?(lens: AqualensLensInstance): void;

  /** Ref that receives the underlying lens instance once it is created. */
  lensRef?: Ref<AqualensLensInstance | null>;
}

export type AqualensProps<C extends React.ElementType = "div"> =
  AqualensOwnProps & {
    as?: C;
  } & Omit<
      React.ComponentPropsWithoutRef<C>,
      keyof AqualensOwnProps | "as" | "children"
    >;

type ElementFromAs<C extends React.ElementType> =
  React.ComponentPropsWithRef<C> extends { ref?: React.Ref<infer E> | undefined }
    ? NonNullable<E>
    : Element;

type AqualensComponent = <C extends React.ElementType = "div">(
  props: AqualensProps<C> & React.RefAttributes<ElementFromAs<C>>,
) => React.ReactElement | null;

function shallowEqual<T extends object>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as (keyof T)[];
  const keysB = Object.keys(b) as (keyof T)[];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function useShallowMemo<T extends object>(value: T | undefined): T | undefined {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
  } else {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function buildConfig(options: {
  resolution?: number;
  refraction?: RefractionOptions;
  glare?: GlareOptions;
  blurRadius?: number;
  blurEdge?: boolean;
  stackingIndex?: number;
  surfaceShape?: SurfaceShape;
  refractiveIndex?: number;
  onInit?: (lens: AqualensLensInstance) => void;
}): AqualensConfig {
  return {
    ...DEFAULT_OPTIONS,
    resolution: options.resolution ?? DEFAULT_OPTIONS.resolution,
    refraction: { ...DEFAULT_OPTIONS.refraction, ...options.refraction },
    glare: { ...DEFAULT_OPTIONS.glare, ...options.glare },
    blurRadius: options.blurRadius ?? DEFAULT_OPTIONS.blurRadius,
    blurEdge: options.blurEdge ?? DEFAULT_OPTIONS.blurEdge,
    stackingIndex: options.stackingIndex,
    surfaceShape: options.surfaceShape ?? DEFAULT_OPTIONS.surfaceShape,
    refractiveIndex: options.refractiveIndex ?? DEFAULT_OPTIONS.refractiveIndex,
    on: options.onInit ? { init: options.onInit } : {},
  };
}

/**
 * Resolve the effective rendering backend.
 *
 * Precedence (highest first):
 *   1. Legacy `powerSave: true` → forces `css` (deprecated path).
 *   2. Explicit `mode` from props.
 *   3. `auto`: `svg` on Chromium browsers, `webgl` elsewhere.
 */
type ResolvedBackend = "webgl" | "svg" | "css";

function resolveBackend(
  mode: RenderMode | undefined,
  powerSave: boolean | undefined,
): ResolvedBackend {
  if (powerSave) return "css";
  const requested = mode ?? "auto";
  if (requested === "webgl" || requested === "svg" || requested === "css") {
    if (requested === "svg" && !supportsSvgBackdropFilter()) return "webgl";
    return requested;
  }
  return supportsSvgBackdropFilter() ? "svg" : "webgl";
}

const AqualensInner = <C extends React.ElementType = "div">(
  {
    children,
    snapshotTarget,
    resolution,
    sourceElement,
    sourceTexture,
    sourceTextureSize,
    refraction,
    glare,
    blurRadius,
    blurEdge,
    stackingIndex,
    opaqueOverlap,
    mode,
    surfaceShape,
    refractiveIndex,
    powerSave,
    onInit,
    lensRef: externalLensRef,
    style,
    className,
    as: Tag,
    ...rest
  }: AqualensProps<C>,
  forwardedRef: React.ForwardedRef<HTMLElement>,
) => {
  const stableRefraction = useShallowMemo(refraction);
  const stableGlare = useShallowMemo(glare);
  const stableSourceTextureSize = useShallowMemo(sourceTextureSize);

  // Resolved backend is sticky for the lifetime of the component to
  // avoid mid-flight swap thrash (which would require recreating the
  // lens instance). Re-run resolution when explicit user inputs change.
  const backend = useMemo<ResolvedBackend>(
    () => resolveBackend(mode, powerSave),
    [mode, powerSave],
  );

  const [webglRenderer, setWebglRenderer] = useState<AqualensRenderer | null>(
    null,
  );
  const webglRendererRef = useRef<AqualensRenderer | null>(null);
  const powerSaveRendererRef = useRef<PowerSaveRenderer | null>(null);
  const svgRendererRef = useRef<SvgRenderer | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const lensInstanceRef = useRef<AqualensLensInstance | null>(null);
  const externalLensRefRef = useRef<typeof externalLensRef>(externalLensRef);

  useEffect(() => {
    externalLensRefRef.current = externalLensRef;
    assignRef(externalLensRef, lensInstanceRef.current);
    return () => {
      assignRef(externalLensRef, null);
    };
  }, [externalLensRef]);

  const setElementRef = useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element;
      assignRef(forwardedRef, element);
    },
    [forwardedRef],
  );

  const setLensInstance = useCallback(
    (lens: AqualensLensInstance | null) => {
      lensInstanceRef.current = lens;
      assignRef(externalLensRefRef.current, lens);
    },
    [],
  );

  useEffect(
    () => () => {
      webglRendererRef.current = null;
      setWebglRenderer(null);
    },
    [],
  );

  useEffect(() => {
    if (backend !== "webgl") {
      webglRendererRef.current = null;
      setWebglRenderer(null);
      return;
    }

    let cancelled = false;
    const target = snapshotTarget ?? undefined;
    const resolutionValue = resolution ?? undefined;

    if (webglRendererRef.current) {
      updateSharedRendererConfig(
        snapshotTarget ?? null,
        resolution,
        sourceElement,
        sourceTexture,
        stableSourceTextureSize,
      );
      return;
    }

    getSharedRenderer(
      target ?? null,
      resolutionValue,
      sourceElement,
      sourceTexture,
      stableSourceTextureSize,
    ).then((rendererInstance: AqualensRenderer) => {
      if (cancelled) return;
      webglRendererRef.current = rendererInstance;
      setWebglRenderer(rendererInstance);
    });
    return () => {
      cancelled = true;
    };
  }, [
    backend,
    snapshotTarget,
    resolution,
    sourceElement,
    sourceTexture,
    stableSourceTextureSize,
  ]);

  useEffect(() => {
    if (backend === "webgl") {
      if (webglRenderer) setOpaqueOverlap(!!opaqueOverlap);
      return;
    }
    if (backend === "svg") {
      setSvgOpaqueOverlap(!!opaqueOverlap);
      return;
    }
  }, [opaqueOverlap, backend, webglRenderer]);

  useEffect(() => {
    if (!elementRef.current) return;

    const config = buildConfig({
      resolution,
      refraction: stableRefraction,
      glare: stableGlare,
      blurRadius,
      blurEdge,
      stackingIndex,
      surfaceShape,
      refractiveIndex,
      onInit,
    });

    if (backend === "css") {
      const powerSaveRenderer = getSharedPowerSaveRenderer();
      powerSaveRendererRef.current = powerSaveRenderer;
      const lens = powerSaveRenderer.addLens(elementRef.current, config);
      setLensInstance(lens);
      return () => {
        lens.destroy();
        setLensInstance(null);
        powerSaveRendererRef.current = null;
      };
    }

    if (backend === "svg") {
      const svgRenderer = getSharedSvgRenderer();
      svgRendererRef.current = svgRenderer;
      svgRenderer.opaqueOverlap = !!opaqueOverlap;
      const lens = svgRenderer.addLens(elementRef.current, config);
      setLensInstance(lens);
      return () => {
        lens.destroy();
        setLensInstance(null);
        svgRendererRef.current = null;
      };
    }

    if (!webglRenderer) return;

    const lens = webglRenderer.addLens(elementRef.current, config);
    setLensInstance(lens);

    return () => {
      lens.destroy();
      setLensInstance(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webglRenderer, backend]);

  useEffect(() => {
    const lens = lensInstanceRef.current;
    if (!lens) return;
    const preservedTint = lens.options.tint;
    const next = buildConfig({
      resolution,
      refraction: stableRefraction,
      glare: stableGlare,
      blurRadius,
      blurEdge,
      stackingIndex,
      surfaceShape,
      refractiveIndex,
      onInit: lens.options.on?.init,
    });
    Object.assign(lens.options, next);
    lens.options.tint = preservedTint;

    if (backend === "css") powerSaveRendererRef.current?.requestRender();
    else if (backend === "svg") svgRendererRef.current?.requestRender();
    else webglRenderer?.requestRender();
  }, [
    resolution,
    stableRefraction,
    stableGlare,
    blurRadius,
    blurEdge,
    stackingIndex,
    surfaceShape,
    refractiveIndex,
    webglRenderer,
    backend,
  ]);

  const mergedStyle = useMemo<CSSProperties>(
    () => ({ position: "relative" as const, ...style }),
    [style],
  );

  const Component = (Tag ?? "div") as React.ElementType;

  // We mark the host element with `LENS_DOM_ATTR` directly in JSX so the very
  // first paint already carries the attribute. The `AqualensLens` constructor
  // also sets it (idempotent), but it only runs after `getSharedRenderer`
  // resolves the snapshot promise. Without this proactive marker, the initial
  // html2canvas snapshot — which clones the DOM synchronously inside
  // `captureSnapshot` — bakes the lens's own DOM content into the source
  // texture, and the lens then refracts itself for the brief window before
  // the next ResizeObserver-triggered recapture clears the texture (see
  // `renderer-snapshot.ts:ignoreElementsFunc`).
  const lensAttrProps = { [LENS_DOM_ATTR]: "" } as Record<string, string>;

  return (
    <Component
      ref={setElementRef as React.Ref<HTMLElement>}
      className={className}
      style={mergedStyle}
      {...lensAttrProps}
      {...rest}
    >
      {children}
    </Component>
  );
};

export const Aqualens = forwardRef(AqualensInner) as AqualensComponent;
