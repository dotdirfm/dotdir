# @dotdirfm/file-list

Reusable multi-column virtual-scrolling file list React component for DotDir.

## Features

- Custom multi-column virtualization (`ColumnsScroller`)
- Virtual scroll with momentum-based touch/inertia scrolling (`ScrollableContainer`)
- Keyboard navigation (cursor movement, selection, page up/down, home/end)
- File operation actions (execute, open, view, edit, trash, delete, copy, move, rename)
- Breadcrumb navigation with overflow cropping
- File info footer with selection summary
- FSS (File Style Sheets) styling integration

## Install

```bash
pnpm add @dotdirfm/file-list
```

## Usage

```tsx
import { FileList } from "@dotdirfm/file-list";
import "@dotdirfm/file-list/file-list.css";

function App() {
  return (
    <FileList
      entries={entries}
      currentPath="/home/user"
      onNavigate={(path) => console.log(path)}
      onSelectionChange={(entries) => console.log(entries)}
    />
  );
}
```

## Exports

| Export | Description |
|--------|-------------|
| `FileList` | Main React component |
| `ActionQueue` | Sequential action execution queue |
| `DisplayEntry`, `FileListState`, `FilePresentation`, etc. | Type definitions |
