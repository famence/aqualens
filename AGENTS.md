# Agent Guidelines for aqualens

Rules and conventions for AI agents and contributors working in this repository.

## Language

**All project communication must be in English.**

- **Comments** — Code comments, JSDoc, and inline documentation must be written in English only.
- **Commit messages** — All git commit messages must be in English. Use conventional commits format when possible (e.g. `feat:`, `fix:`, `docs:`).
- **Demo content** — Text, labels, UI strings, and any user-facing content in the demo app (`demo/`) must be in English only.
- **Documentation** — README, docs, and other project documentation must be in English.

## Project Structure

- **Monorepo** — Root `package.json` defines workspaces: `packages/core`, `packages/react`.
- **Core** — `packages/core` contains the main library (WebGL, lens, renderers).
- **React** — `packages/react` provides React bindings and components.
- **Demo** — `demo/` is a Next.js app for showcasing the library.

## Code Conventions

- **TypeScript** — Use strict TypeScript. Avoid `any` unless necessary.
- **No index files** — Do not create barrel/index files (e.g. `index.ts`).
- **Exports** — Export from source files directly; avoid re-export barrels.

## Before Committing

1. Run `npm run typecheck` to ensure types are valid.
2. Run `npm run build` to verify the build succeeds.
3. Ensure all new comments and commit messages are in English.
4. Ensure demo app content is in English.

## Cursor Cloud specific instructions

- **Node.js** — The project requires Node.js >= 20.9 (needed by the demo app's Next.js 16 dependency). The update script installs Node 22 via nvm.
- **Two-phase install** — The demo app (`demo/`) is **not** part of the npm workspaces. After `npm install` at the repo root, run `npm install` separately inside `demo/`.
- **Build order** — Core must build before React. Use `npm run build` at the repo root (it handles ordering). The demo app links to local packages via `file:` references and requires the library packages to be built first.
- **Typecheck** — Run from root: `npm run typecheck`. This validates both `packages/core` and `packages/react`.
- **Lint** — The demo app has no ESLint config; `npm run lint` inside `demo/` will fail. This is expected. Linting is not configured for the library packages either.
- **Demo dev server** — `cd demo && npm run dev` starts Next.js 16 with Turbopack on `http://localhost:3000`. The glass effects require a WebGL2-capable browser; in headless environments effects won't render visually but the server still responds.
- **No tests** — There is no test framework configured in this repository (no jest, vitest, or test scripts). Verify changes via `npm run typecheck` and `npm run build`.
