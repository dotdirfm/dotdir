# @dotdirfm/ui-utils

Shared utilities for DotDir file manager UI.

## Install

```bash
pnpm add @dotdirfm/ui-utils
```

## Exports

### Path utilities
`normalizePath`, `dirname`, `join`, `basename`, `resolveDotSegments`, `isRootPath`, `getBreadcrumbSegments`, `isFileExecutable`

### Container path utilities
`isContainerPath`, `parseContainerPath`, `buildContainerPath`, `containerFile`, `containerInner`, `CONTAINER_SEP`

### Platform detection
`isMac`, `isWindows` — uses `navigator.userAgentData` with `navigator.platform` fallback

### React utilities
`ComposeProviders` — flattens nested React providers
`useMediaQuery` — responsive media query hook

### General utilities
`binarySearch`, `cx` (CSS Modules classname helper), `INPUT_NO_ASSIST` (disable browser autofill), `isImageFile`/`isVideoFile`/`isMediaFile`, `Registry<T>`, `getStyleHostElement`
