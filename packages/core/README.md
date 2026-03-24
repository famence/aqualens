# @aqualens/core

Framework-agnostic **liquid glass** effect for the web: WebGL2 refraction, glare, and backdrop capture. Used by [`@aqualens/react`](../react/README.md) and any vanilla or framework integration.

**[Live demo](https://famence.github.io/aqualens/)**

[![Aqualens demo screenshot](https://raw.githubusercontent.com/famence/aqualens/main/assets/demo.png)](https://famence.github.io/aqualens/)

## Requirements

- **WebGL2** in the browser (current Chrome, Firefox, Safari, Edge).
- **DOM**: runs in the browser; snapshot capture uses [`html2canvas-pro`](https://www.npmjs.com/package/html2canvas-pro) (already a dependency).

## Install

```bash
npm install @aqualens/core
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
  refraction: { ...DEFAULT_OPTIONS.refraction, thickness: 24 },
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
npm run build   # tsup → dist/
npm run typecheck
```

## License

MIT
