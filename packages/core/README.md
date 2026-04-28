# @aqualens/core

Framework-agnostic **liquid glass** effect for the web: WebGL2 refraction, glare, and backdrop capture. Used by [`@aqualens/react`](../react/README.md) and any vanilla or framework integration.

**[Live demo](https://famence.github.io/aqualens/)**

[![Aqualens demo screenshot](https://raw.githubusercontent.com/famence/aqualens/main/assets/demo.png)](https://famence.github.io/aqualens/)

## Requirements

- **WebGL2** in the browser (current Chrome, Firefox, Safari, Edge).
- **DOM**: runs in the browser; snapshot capture uses [`html2canvas-pro`](https://www.npmjs.com/package/html2canvas-pro), which you must install as a **peer dependency** (same major range as listed in `@aqualens/core`’s `peerDependencies`).

## Install

```bash
npm install @aqualens/core html2canvas-pro
```

## Quick start (shared renderer)

Most apps use one fullscreen (or region) backdrop and several glass elements. Use the **shared renderer** so every lens shares the same WebGL context and snapshot:

```ts
import {
  getSharedRenderer,
  updateSharedRendererConfig,
  DEFAULT_OPTIONS,
  type AqualensConfig,
} from "@aqualens/core";

// 1. Resolve once (defaults: document.body, resolution 2)
const renderer = await getSharedRenderer(
  document.getElementById("backdrop"),
  2,
);

// 2. Optional: when the snapshot root or resolution changes later
await updateSharedRendererConfig(
  document.getElementById("backdrop"),
  2,
);

// 3. Build full config (merge with defaults; tint is filled from the element’s CSS background)
const config: AqualensConfig = {
  ...DEFAULT_OPTIONS,
  resolution: 2,
  refraction: { ...DEFAULT_OPTIONS.refraction, thickness: 24, zoom: 0.2 },
  glare: { ...DEFAULT_OPTIONS.glare, factor: 40 },
  blurRadius: 4,
  blurEdge: true,
  on: {
    init(lens) {
      /* lens ready */
    },
  },
};

const el = document.getElementById("glass")!;
const lens = renderer.addLens(el, config);

// 4. Shared helper already started the render loop after first getSharedRenderer().
// Re-capture the backdrop after large layout/content changes:
await renderer.captureSnapshot();
```

**Stacked glass (macOS-style overlap):** if lenses use different `z-index` values and upper panes should “cut through” lower ones against the original snapshot, call `setOpaqueOverlap(true)` (see API below).

## Quick start (own `AqualensRenderer`)

For a second scene or full control over lifecycle, instantiate the renderer directly:

```ts
import { AqualensRenderer, DEFAULT_OPTIONS, type AqualensConfig } from "@aqualens/core";

const renderer = new AqualensRenderer(snapshotRootElement, 2);
await renderer.captureSnapshot();
renderer.startRenderLoop();

const config: AqualensConfig = { ...DEFAULT_OPTIONS /* … */ };
renderer.addLens(glassElement, config);
```

Remember to call `renderer.destroy()` when tearing down.

## Dynamic content

Elements that update frequently (e.g. animated children) can be registered so the engine can update the snapshot path:

```ts
renderer.addDynamicElement(movingNode);
// or multiple / selector string overloads
```

## Reveal overlays (`data-liquid-reveal-*`)

The renderer supports a reveal layer API for "Apple Music style" tab indicators and similar UI, where alternate content is shown only when a lens with a high-enough stacking index is present.

- `data-liquid-reveal-index="{number}"` — required; threshold value used by the renderer to decide whether the reveal is eligible for a lens/group.
- `data-liquid-reveal-mode="under-lens" | "on-lens"` — optional; default is `under-lens`.

```html
<!-- Base label (normal content) -->
<div class="tab-label">Genres</div>

<!-- Reveal label (alternate colored content) -->
<div
  data-liquid-reveal-index="11"
  data-liquid-reveal-mode="on-lens"
  class="tab-label tab-label--accent"
>
  Genres
</div>
```

Mode behavior:

- `under-lens`: reveal content is composited into the source texture before the glass render pass, so it appears below the lens tint.
- `on-lens`: reveal content is drawn after the lens render pass, clipped by the lens SDF, so it appears above the dark tint while still living inside the lens silhouette.
- `on-lens` keeps refraction enabled: displacement and chromatic dispersion are driven by the owning lens's `refraction.thickness`, `refraction.factor`, and `refraction.dispersion`.

Migration note:

- Rename legacy `data-liquid-reveal` to `data-liquid-reveal-index`.

## Power-save mode (lighter GPU path)

For a CSS/SVG-style fallback with reduced GPU work, the package exposes `PowerSaveRenderer`, `PowerSaveLens`, and `getSharedPowerSaveRenderer()`. Wire them the same way as your UI strategy (see the React package’s `powerSave` prop for reference).

## Main exports

| Export | Role |
|--------|------|
| `getSharedRenderer`, `updateSharedRendererConfig`, `setOpaqueOverlap` | Single shared WebGL renderer for the page |
| `getSharedPowerSaveRenderer` | Shared power-save renderer |
| `AqualensRenderer` | Dedicated WebGL renderer instance |
| `AqualensLens` | Lens instance type (usually created via `addLens`) |
| `PowerSaveRenderer`, `PowerSaveLens` | Power-save implementations |
| `DEFAULT_OPTIONS`, `DEFAULT_TINT` | Default `AqualensConfig` and tint fallback |
| Types: `AqualensConfig`, `AqualensOptions`, `AqualensLensOptions`, `RefractionOptions`, `GlareOptions`, … | TypeScript definitions |

## Styling notes

- The lens reads **`border-radius`** and **`background-color`** from the target element; the latter drives glass **tint** (then the real background is made transparent for the WebGL pass).
- **`box-shadow`** on the element is parsed for rendering; the DOM shadow is suppressed while the lens is active.

## Scripts (monorepo / package root)

```bash
npm run build   # NODE_ENV=production tsup → minified dist/ (no source maps)
npm run dev     # watch build without minification (faster iteration)
npm run typecheck
```

## License

MIT
