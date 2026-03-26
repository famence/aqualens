import { useRef, useEffect, useState, useCallback } from "react";
import {
  getSharedRenderer,
  AqualensRenderer,
  type AqualensRenderMode,
} from "@aqualens/core";

type AnyRenderer = Awaited<ReturnType<typeof getSharedRenderer>>;

/**
 * Hook for accessing the shared Aqualens renderer.
 */
export function useAqualens(mode?: AqualensRenderMode) {
  const [renderer, setRenderer] = useState<AnyRenderer | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSharedRenderer(null, undefined, mode)
      .then((rendererInstance) => {
        if (cancelled) return;
        setRenderer(rendererInstance);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const recapture = useCallback(() => {
    if (renderer && renderer instanceof AqualensRenderer) {
      return renderer.captureSnapshot();
    }
    return Promise.resolve(false);
  }, [renderer]);

  const registerDynamic = useCallback(
    (element: HTMLElement | HTMLElement[]) => {
      if (renderer && renderer instanceof AqualensRenderer) {
        renderer.addDynamicElement(element);
      }
    },
    [renderer],
  );

  return {
    renderer,
    ready,
    recapture,
    registerDynamic,
  };
}

/**
 * Hook to register a ref as a dynamic element for real-time refraction updates.
 * Only relevant for WebGL mode.
 */
export function useDynamicElement<T extends HTMLElement>(mode?: AqualensRenderMode) {
  const ref = useRef<T>(null);
  const { registerDynamic, ready } = useAqualens(mode);

  useEffect(() => {
    if (ready && ref.current) {
      registerDynamic(ref.current);
    }
  }, [ready, registerDynamic]);

  return ref;
}
