import { useRef, useEffect, useState, useCallback } from "react";
import { getSharedRenderer } from "@aqualens/core";

/**
 * Hook for accessing the shared Aqualens renderer.
 */
export function useAqualens() {
  const [renderer, setRenderer] = useState<Awaited<ReturnType<typeof getSharedRenderer>> | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSharedRenderer()
      .then((rendererInstance) => {
        if (cancelled) return;
        setRenderer(rendererInstance);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recapture = useCallback(() => {
    if (renderer) return renderer.captureSnapshot();
    return Promise.resolve(false);
  }, [renderer]);

  const registerDynamic = useCallback(
    (element: HTMLElement | HTMLElement[]) => {
      if (renderer) renderer.addDynamicElement(element);
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
 */
export function useDynamicElement<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const { registerDynamic, ready } = useAqualens();

  useEffect(() => {
    if (ready && ref.current) {
      registerDynamic(ref.current);
    }
  }, [ready, registerDynamic]);

  return ref;
}
