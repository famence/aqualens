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
