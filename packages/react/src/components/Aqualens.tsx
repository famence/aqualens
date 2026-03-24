import React, {
  useEffect,
  useRef,
  useState,
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
  getSharedPowerSaveRenderer,
  DEFAULT_OPTIONS,
  type AqualensRenderer,
  type AqualensLensInstance,
  type AqualensConfig,
  type PowerSaveRenderer,
  type RefractionOptions,
  type GlareOptions,
} from "@aqualens/core";

export interface AqualensProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  children?: ReactNode;
  /** Target element for the snapshot background. */
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
   * snapshot (macOS-style). Applies to the shared WebGL renderer only. @default false
   */
  opaqueOverlap?: boolean;

  /** CSS/SVG fallback without WebGL for reduced GPU load. */
  powerSave?: boolean;

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
      powerSave,
      onInit,
      style,
      className,
      as: Tag = "div",
      ...rest
    },
    ref,
  ) {
    const [renderer, setRenderer] = useState<AqualensRenderer | null>(null);
    const rendererRef = useRef<AqualensRenderer | null>(null);
    const powerSaveRendererRef = useRef<PowerSaveRenderer | null>(null);
    const elementRef = useRef<HTMLDivElement>(null);
    const lensRef = useRef<AqualensLensInstance | null>(null);

    useImperativeHandle(ref, () => ({
      get lens() {
        return lensRef.current;
      },
      get element() {
        return elementRef.current;
      },
    }));

    useEffect(() => (
      () => {
        rendererRef.current = null;
        setRenderer(null);
      }
    ), []);

    useEffect(() => {
      if (powerSave) {
        rendererRef.current = null;
        setRenderer(null);
        return;
      }

      let cancelled = false;
      const target = snapshotTarget ?? undefined;
      const resolutionValue = resolution ?? undefined;

      if (rendererRef.current) {
        updateSharedRendererConfig(snapshotTarget ?? null, resolution);
        return;
      }

      getSharedRenderer(target ?? null, resolutionValue).then(
        (rendererInstance: AqualensRenderer) => {
          if (cancelled) return;
          rendererRef.current = rendererInstance;
          setRenderer(rendererInstance);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [snapshotTarget, resolution, powerSave]);

    useEffect(() => {
      if (powerSave || !renderer) return;
      setOpaqueOverlap(!!opaqueOverlap);
    }, [opaqueOverlap, powerSave, renderer]);

    useEffect(() => {
      if (!elementRef.current) return;

      const config = buildConfig({
        resolution,
        refraction,
        glare,
        blurRadius,
        blurEdge,
        onInit,
      });

      if (powerSave) {
        const powerSaveRenderer = getSharedPowerSaveRenderer();
        powerSaveRendererRef.current = powerSaveRenderer;
        const lens = powerSaveRenderer.addLens(elementRef.current, config);
        lensRef.current = lens;
        return () => {
          lens.destroy();
          lensRef.current = null;
          powerSaveRendererRef.current = null;
        };
      }

      if (!renderer) return;

      const lens = renderer.addLens(elementRef.current, config);
      lensRef.current = lens;

      return () => {
        lens.destroy();
        lensRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderer, powerSave]);

    useEffect(() => {
      const lens = lensRef.current;
      if (!lens) return;
      const preservedTint = lens.options.tint;
      const next = buildConfig({
        resolution,
        refraction,
        glare,
        blurRadius,
        blurEdge,
        onInit: lens.options.on?.init,
      });
      Object.assign(lens.options, next);
      lens.options.tint = preservedTint;

      if (powerSave) {
        powerSaveRendererRef.current?.requestRender();
      } else {
        renderer?.requestRender();
      }
    }, [
      resolution,
      refraction,
      glare,
      blurRadius,
      blurEdge,
      renderer,
      powerSave,
    ]);

    const Component = Tag as React.ElementType;

    return (
      <Component
        ref={elementRef}
        className={className}
        style={{
          position: "relative",
          ...style,
        }}
        {...rest}
      >
        {children}
      </Component>
    );
  },
);
