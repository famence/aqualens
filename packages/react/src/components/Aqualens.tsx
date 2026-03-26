import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import {
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
  DEFAULT_OPTIONS,
  AqualensRenderer,
  type AqualensLensInstance,
  type AqualensConfig,
  type AqualensRenderMode,
  type RefractionOptions,
  type GlareOptions,
} from "@aqualens/core";

type AnyRenderer = Awaited<ReturnType<typeof getSharedRenderer>>;

export interface AqualensProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  children?: ReactNode;
  /** Target element for the snapshot background (WebGL mode only). */
  snapshotTarget?: HTMLElement | null;
  /** Render resolution multiplier (0.1–3.0). @default 2.0 */
  resolution?: number;

  /** Refraction (distortion) parameters. */
  refraction?: RefractionOptions;
  /** Glare (specular highlight) parameters. */
  glare?: GlareOptions;

  /** Gaussian blur radius in pixels. @default 1 */
  blurRadius?: number;
  /** Clip blur at element edges. @default true */
  blurEdge?: boolean;

  /**
   * When true, lenses at higher CSS z-index clip lower ones and sample the original
   * snapshot (macOS-style). Applies to WebGL mode only. @default false
   */
  opaqueOverlap?: boolean;

  /**
   * Rendering backend selection.
   * - `"auto"` (default) — SVG preferred; falls back to CSS on low-power devices, WebGL otherwise.
   * - `"webgl"` — Force WebGL2 pipeline (requires `html2canvas-pro`).
   * - `"svg"` — Force SVG displacement + CSS backdrop pipeline.
   * - `"css"` — Force lightweight CSS-only pipeline.
   */
  mode?: AqualensRenderMode;

  /** Called once after the lens is initialized. */
  onInit?(lens: AqualensLensInstance): void;
  style?: CSSProperties;
  className?: string;
  as?: React.ElementType;
}

export interface AqualensRef {
  lens: AqualensLensInstance | null;
  element: HTMLDivElement | null;
}

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

function useShallowMemo<T extends object>(
  value: T | undefined,
): T | undefined {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

function buildConfig(options: {
  resolution?: number;
  refraction?: RefractionOptions;
  glare?: GlareOptions;
  blurRadius?: number;
  blurEdge?: boolean;
  onInit?: (lens: AqualensLensInstance) => void;
}): AqualensConfig {
  return {
    ...DEFAULT_OPTIONS,
    resolution: options.resolution ?? DEFAULT_OPTIONS.resolution,
    refraction: { ...DEFAULT_OPTIONS.refraction, ...options.refraction },
    glare: { ...DEFAULT_OPTIONS.glare, ...options.glare },
    blurRadius: options.blurRadius ?? DEFAULT_OPTIONS.blurRadius,
    blurEdge: options.blurEdge ?? DEFAULT_OPTIONS.blurEdge,
    on: options.onInit ? { init: options.onInit } : {},
  };
}

export const Aqualens = forwardRef<AqualensRef, AqualensProps>(
  function Aqualens(
    {
      children,
      snapshotTarget,
      resolution,
      refraction,
      glare,
      blurRadius,
      blurEdge,
      opaqueOverlap,
      mode = "auto",
      onInit,
      style,
      className,
      as: Tag = "div",
      ...rest
    },
    ref,
  ) {
    const stableRefraction = useShallowMemo(refraction);
    const stableGlare = useShallowMemo(glare);

    const [renderer, setRenderer] = useState<AnyRenderer | null>(null);
    const elementRef = useRef<HTMLDivElement>(null);
    const lensRef = useRef<AqualensLensInstance | null>(null);
    const activeModeRef = useRef<AqualensRenderMode>(mode);

    useImperativeHandle(ref, () => ({
      get lens() { return lensRef.current; },
      get element() { return elementRef.current; },
    }), []);

    useEffect(() => {
      let cancelled = false;
      activeModeRef.current = mode;

      getSharedRenderer(
        snapshotTarget ?? null,
        resolution ?? undefined,
        mode,
      ).then((inst) => {
        if (cancelled) return;
        setRenderer((prev) => {
          if (prev === inst) return prev;
          return inst;
        });
      });

      return () => { cancelled = true; };
    }, [snapshotTarget, resolution, mode]);

    useEffect(() => {
      if (!renderer || !(renderer instanceof AqualensRenderer)) return;
      setOpaqueOverlap(!!opaqueOverlap);
    }, [opaqueOverlap, renderer]);

    useEffect(() => {
      if (!elementRef.current || !renderer) return;

      const config = buildConfig({
        resolution,
        refraction: stableRefraction,
        glare: stableGlare,
        blurRadius,
        blurEdge,
        onInit,
      });

      const lens = renderer.addLens(elementRef.current, config);
      lensRef.current = lens;

      return () => {
        lens.destroy();
        lensRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderer]);

    useEffect(() => {
      const lens = lensRef.current;
      if (!lens) return;
      const preservedTint = lens.options.tint;
      const next = buildConfig({
        resolution,
        refraction: stableRefraction,
        glare: stableGlare,
        blurRadius,
        blurEdge,
        onInit: lens.options.on?.init,
      });
      Object.assign(lens.options, next);
      lens.options.tint = preservedTint;

      if (renderer && "requestRender" in renderer) {
        (renderer as any).requestRender();
      }
    }, [
      resolution,
      stableRefraction,
      stableGlare,
      blurRadius,
      blurEdge,
      renderer,
    ]);

    const mergedStyle = useMemo<CSSProperties>(
      () => ({ position: "relative" as const, ...style }),
      [style],
    );

    const Component = Tag as React.ElementType;

    return (
      <Component
        ref={elementRef}
        className={className}
        style={mergedStyle}
        {...rest}
      >
        {children}
      </Component>
    );
  },
);
