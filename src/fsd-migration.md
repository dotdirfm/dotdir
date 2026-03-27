# Frontend FSD Migration

This file tracks the incremental migration from the current flat `src` layout
to a feature-sliced structure adapted to Faraday's architecture.

## Target layers

- `app`: bootstrapping, providers, truly global setup/styles
- `processes`: long-running cross-feature orchestration
- `widgets`: composed UI blocks
- `features`: user-facing actions and flows
- `entities`: business entities and local domain state
- `shared`: low-level APIs, utilities, cross-cutting primitives

## Migration rules

- Migrate in small, behavior-preserving steps.
- Keep backward-compatible shims during transitions.
- Move call sites first, then remove shims once unused.
- Avoid large file moves mixed with behavior changes.

## Current progress

1. Added top-level layer folders.
2. Migrated `commandLineCd` to `features/navigation/lib/commandLineCd`.
3. Kept `src/commandLineCd.ts` as a compatibility re-export.
4. Updated `App` imports to use the new feature path.
5. Migrated file operation modules to `features/file-ops/model`:
   - `useFileOperations`
   - `fileOperationHandlers`
6. Kept compatibility re-exports at old paths:
   - `src/hooks/useFileOperations.ts`
   - `src/fileOperationHandlers.ts`
7. Updated key call sites/types to use the new feature paths directly.
8. Introduced panel entity model:
   - `entities/panel/model/types.ts` (`PanelSide`)
   - `entities/panel/model/panelSide.ts`
9. Introduced tab entity model:
   - `entities/tab/model/tabsAtoms.ts`
10. Kept compatibility re-exports for:
   - `src/panelSide.ts`
   - `src/tabsAtoms.ts`
11. Updated major consumers to import from `entities/*` paths directly.
12. Extracted workspace session process into:
    - `processes/workspace-session/model/useWorkspaceSessionProcess.ts`
    - `useWorkspaceRestoreProcess` (initial restore from UI state)
    - `useWorkspacePersistenceProcess` (debounced persistence + beforeunload flush)
13. Wired `app.tsx` to use the new process hooks.
14. Introduced canonical bridge module at:
    - `shared/api/bridge/index.ts`
15. Converted legacy `src/bridge.ts` into a compatibility re-export shim.
16. Updated key entry imports to use the new bridge path:
    - `main.tsx`
    - `app.tsx`
    - `App.tsx`
    - `extensions.ts`

## Next recommended steps

1. Finish moving remaining `./bridge` consumers to `shared/api/bridge`.
2. Move `tauriBridge.ts` and `wsBridge.ts` under `shared/api/bridge/transport` (then shim old paths).
3. Remove compatibility shims once no imports depend on legacy paths.
4. Optionally split `App` orchestration further (commands/viewer-editor runtime).
