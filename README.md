# DotDir

DotDir is a keyboard-friendly dual-pane file manager with a built-in terminal, command palette, extension support, and a reusable React UI package.

This repository contains the main desktop app plus the shared UI workspace used by the website demo and npm package.

## Overview

DotDir is designed for fast navigation and file operations with a modern, embeddable UI.

What’s in this repo:

- desktop app built with Tauri + React
- reusable UI package published as [`@dotdirfm/ui`](https://www.npmjs.com/package/@dotdirfm/ui)
- shared workspace packages used by the app

## Workspace

Key directories:

- [`src`](./dotdir/src) — app frontend
- [`src-tauri`](./dotdir/src-tauri) — desktop shell and native backend
- [`packages/ui`](./dotdir/packages/ui) — reusable DotDir UI package
- [`packages/extension-api`](./dotdir/packages/extension-api) — shared extension API package

## Prerequisites

- Node.js 22+
- `pnpm`
- Rust stable toolchain
- Tauri prerequisites for your platform

Linux users may also need the usual Tauri WebKit/system packages, such as:

```bash
sudo apt update
sudo apt install \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

## Install

From the repo root:

```bash
pnpm install
```

## Development

Start the frontend dev server:

```bash
pnpm dev
```

Start the desktop app in development mode:

```bash
pnpm tauri dev
```

Run the app via the custom Tauri subcommand used in this project:

```bash
pnpm serve
```

## Build

Build the frontend:

```bash
pnpm build
```

Build the desktop app:

```bash
pnpm tauri build
```

## Quality Checks

Run linting:

```bash
pnpm lint
```

Auto-fix formatting/lint issues:

```bash
pnpm fmt
```

## UI Package

The shared UI package lives in [`packages/ui`](./dotdir/packages/ui) and is published separately as `@dotdirfm/ui`.

Package-specific docs:

- [`packages/ui/README.md`](./dotdir/packages/ui/README.md)

## Links

- GitHub: [dotdirfm/dotdir](https://github.com/dotdirfm/dotdir)
- npm: [`@dotdirfm/ui`](https://www.npmjs.com/package/@dotdirfm/ui)
- Issues: [github.com/dotdirfm/dotdir/issues](https://github.com/dotdirfm/dotdir/issues)
