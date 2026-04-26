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
  DEFAULT_OPTIONS,
  type AqualensRenderer,
  type AqualensLensInstance,
  type AqualensConfig,
  type PowerSaveRenderer,
  type RefractionOptions,
  type GlareOptions,
} from "@aqualens/core";

interface AqualensOwnProps {
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
   * Explicit stacking index that controls lens merge grouping and overlay priority.
   * Lenses with the same stackingIndex merge together; higher values render on top.
   * When omitted, the lens is rendered individually (no merging) in natural DOM order
   * and always below any lens that has an explicit stackingIndex.
   */
  stackingIndex?: number;

  /**
   * When true, lenses at different stackingIndex values clip lower ones and sample
   * the original snapshot (macOS-style). Applies to the shared WebGL renderer only.
   * @default false
   */
  opaqueOverlap?: boolean;

  /** CSS/SVG fallback without WebGL for reduced GPU load. */
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
    on: options.onInit ? { init: options.onInit } : {},
  };
}

const AqualensInner = <C extends React.ElementType = "div">(
  {
    children,
    snapshotTarget,
    resolution,
    refraction,
    glare,
    blurRadius,
    blurEdge,
    stackingIndex,
    opaqueOverlap,
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

  const [renderer, setRenderer] = useState<AqualensRenderer | null>(null);
  const rendererRef = useRef<AqualensRenderer | null>(null);
  const powerSaveRendererRef = useRef<PowerSaveRenderer | null>(null);
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
      rendererRef.current = null;
      setRenderer(null);
    },
    [],
  );

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
      refraction: stableRefraction,
      glare: stableGlare,
      blurRadius,
      blurEdge,
      stackingIndex,
      onInit,
    });

    if (powerSave) {
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

    if (!renderer) return;

    const lens = renderer.addLens(elementRef.current, config);
    setLensInstance(lens);

    return () => {
      lens.destroy();
      setLensInstance(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, powerSave]);

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
    stableRefraction,
    stableGlare,
    blurRadius,
    blurEdge,
    stackingIndex,
    renderer,
    powerSave,
  ]);

  const hasChildren = children != null && children !== false;

  useEffect(() => {
    if (!hasChildren || powerSave || !elementRef.current) return;

    let target: HTMLElement | null = null;
    let node: HTMLElement | null = elementRef.current;

    while (node && node !== document.body) {
      const cs = window.getComputedStyle(node);
      if (cs.position === "fixed") {
        const z = cs.zIndex;
        if (z === "auto" || parseInt(z, 10) <= 0) {
          target = node;
        }
        break;
      }
      node = node.parentElement;
    }

    if (!target) return;

    const origZ = target.style.zIndex;
    target.style.zIndex = "1";

    return () => {
      target!.style.zIndex = origZ;
    };
  }, [hasChildren, powerSave]);

  const mergedStyle = useMemo<CSSProperties>(
    () => ({ position: "relative" as const, ...style }),
    [style],
  );

  const Component = (Tag ?? "div") as React.ElementType;

  return (
    <Component
      ref={setElementRef as React.Ref<HTMLElement>}
      className={className}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </Component>
  );
};

export const Aqualens = forwardRef(AqualensInner) as AqualensComponent;
