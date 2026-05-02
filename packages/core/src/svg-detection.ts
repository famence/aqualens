/**
 * Feature detection for the SVG-as-`backdrop-filter` rendering mode.
 *
 * The SVG backend relies on the *non-standard* Chromium behaviour of
 * accepting `backdrop-filter: url(#filterId)` references and routing
 * them through the SVG filter pipeline. As of mid-2026 this is still
 * limited to Chromium-derived browsers (Chrome, Edge, Opera, Brave,
 * Arc, …). Safari and Firefox parse the syntax but do *not* render
 * the SVG filter — applying it would result in a no-op visible as
 * "the lens is fully transparent".
 *
 * Hence we use a two-stage check:
 *  1. CSS feature query — `backdrop-filter` (or its WebKit alias)
 *     must be supported by the browser at all. This rules out
 *     Firefox versions older than the ones that shipped
 *     `backdrop-filter`.
 *  2. Chromium engine identification — preferred via UA-CH
 *     (`navigator.userAgentData`), which Chromium browsers expose with
 *     a stable `brands` array. If UA-CH is unavailable we fall back to
 *     the legacy `userAgent` string heuristic that excludes Safari
 *     (which spoofs `Chrome` only on iOS as `CriOS`) and Firefox.
 *
 * The result is cached for the lifetime of the page — the user agent
 * cannot change without a navigation.
 */

let cachedSupport: boolean | null = null;

interface UserAgentBrand {
  brand: string;
  version: string;
}

interface UserAgentDataLike {
  brands?: UserAgentBrand[];
}

export function supportsSvgBackdropFilter(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    cachedSupport = false;
    return false;
  }

  const cssApi = (
    window as unknown as { CSS?: { supports?: (...args: string[]) => boolean } }
  ).CSS;
  const supportsBackdropFilter =
    cssApi?.supports?.("backdrop-filter", "blur(1px)") ||
    cssApi?.supports?.("-webkit-backdrop-filter", "blur(1px)") ||
    false;
  if (!supportsBackdropFilter) {
    cachedSupport = false;
    return false;
  }

  const navigatorWithUaData = navigator as unknown as {
    userAgentData?: UserAgentDataLike;
  };
  const uaData = navigatorWithUaData.userAgentData;
  if (uaData && Array.isArray(uaData.brands) && uaData.brands.length > 0) {
    const isChromium = uaData.brands.some((entry) =>
      /chromium|google chrome|microsoft edge|opera|brave/i.test(entry.brand),
    );
    cachedSupport = isChromium;
    return isChromium;
  }

  // UA fallback. Safari has neither "Chrome/" nor "Chromium" in its
  // desktop UA string, so excluding Firefox/CriOS is sufficient on the
  // platforms we care about.
  const ua = navigator.userAgent || "";
  const isFirefox = /Firefox\//.test(ua);
  const isAppleWebKit =
    /Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Edg\//.test(ua);
  const isChromiumUa =
    /(Chrome|CriOS|Chromium|Edg|OPR|Brave)\//.test(ua) && !isFirefox;
  cachedSupport = isChromiumUa && !isAppleWebKit;
  return cachedSupport;
}

/** Test override entry point — useful for unit tests / SSR scenarios. */
export function _setSvgSupportForTesting(value: boolean | null): void {
  cachedSupport = value;
}
