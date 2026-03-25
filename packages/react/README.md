# @aqualens/react

React 18+ bindings for **[@aqualens/core](../core/README.md)**: a declarative `<Aqualens>` wrapper, refs, and hooks on top of the shared WebGL renderer.

**[Live demo](https://famence.github.io/aqualens/)**

[![Aqualens demo screenshot](https://raw.githubusercontent.com/famence/aqualens/main/assets/demo.png)](https://famence.github.io/aqualens/)

## Requirements

- **React** and **React DOM** `>= 18`
- Same browser requirements as core: **WebGL2**
- **[`html2canvas-pro`](https://www.npmjs.com/package/html2canvas-pro)** — peer dependency (required for backdrop capture; install it in your app)

## Install

```bash
npm install @aqualens/react html2canvas-pro
```

`@aqualens/core` is installed as a dependency of this package. You still need **`html2canvas-pro`** in your project because it is a peer dependency of `@aqualens/core` (and of `@aqualens/react`).

## Quick start

```tsx
"use client"; // Next.js App Router — effect needs the client

import { Aqualens } from "@aqualens/react";

export function HeroGlass() {
  return (
    <div className="relative" id="backdrop">
      {/* Background content to refract */}
      <img
        src="/bg.jpg"
        alt=""
        className="absolute inset-0 size-full object-cover"
      />

      <Aqualens
        className="absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 rounded-3xl p-6 bg-white/20"
        refraction={{ thickness: 22, factor: 1.4 }}
        glare={{ factor: 35, range: 20 }}
        blurRadius={4}
      >
        <p>Content inside the glass</p>
      </Aqualens>
    </div>
  );
}
```

- **`snapshotTarget`**: root element whose subtree is captured as the refracted backdrop (often the same wrapper as your background). If omitted, the shared renderer falls back to `document.body`.
- **`style` / `className`**: use a **semi-transparent `background-color`** so the library can infer tint; `border-radius` defines the glass shape.

## Props (high level)

| Prop | Description |
| --- | --- |
| `snapshotTarget` | Snapshot root: `HTMLElement` or `null`. |
| `resolution` | `0.1`–`3.0`, default `2` — internal capture scale. |
| `refraction`, `glare` | Same shapes as core (`RefractionOptions`, `GlareOptions`). |
| `blurRadius`, `blurEdge` | Blur strength and edge clamping. |
| `opaqueOverlap` | macOS-style stacking when lenses use different `z-index`. |
| `powerSave` | Use lightweight non-WebGL path. |
| `onInit` | <code>(lens) => void</code> when the lens is ready. |
| `as` | Polymorphic host element (default `div`). |
| *(also)* | Standard `HTMLAttributes` for the host (except `children` typing). |

## Ref

```tsx
import { useRef } from "react";
import { Aqualens, type AqualensRef } from "@aqualens/react";

const ref = useRef<AqualensRef>(null);
// ref.current?.lens — AqualensLensInstance
// ref.current?.element — host DOM node
```

## Hooks

### `useAqualens()`

Access the **shared** core renderer after it resolves:

```tsx
import { useAqualens } from "@aqualens/react";

function Toolbar() {
  const { renderer, ready, recapture, registerDynamic } = useAqualens();

  return (
    <button type="button" disabled={!ready} onClick={() => void recapture()}>
      Refresh backdrop
    </button>
  );
}
```

- **`recapture()`** — `renderer.captureSnapshot()` when the shared instance exists.
- **`registerDynamic(el)`** — forwards to `addDynamicElement` for moving/updating regions.

### `useDynamicElement<T>()`

Returns a ref that registers its node with the shared renderer when ready (convenience over `registerDynamic`).

```tsx
const motionRef = useDynamicElement<HTMLDivElement>();
return <div ref={motionRef}>…</div>;
```

## Re-exported core API

For advanced usage you can import from `@aqualens/react` or `@aqualens/core` interchangeably for types and helpers, for example:

`AqualensRenderer`, `getSharedRenderer`, `updateSharedRendererConfig`, `setOpaqueOverlap`, `DEFAULT_OPTIONS`, and the main TypeScript types.

## Example project

The interactive demo runs at **[famence.github.io/aqualens](https://famence.github.io/aqualens/)**.  
The monorepo **demo** app (`demo/` at the repository root) shows controls, `opaqueOverlap`, and `powerSave` toggles — use it as a full integration reference.

## Scripts (monorepo / package root)

```bash
npm run build
npm run typecheck
```

## License

MIT
