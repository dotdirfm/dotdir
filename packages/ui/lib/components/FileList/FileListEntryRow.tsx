import { FileIcon } from "@/features/file-icons/FileIcon";
import { cx } from "@/utils/cssModules";
import { memo } from "react";
import styles from "./FileList.module.css";
import type { DisplayEntry } from "./types";
import { formatSize } from "./utils";

interface FileListEntryRowProps {
  item: DisplayEntry;
  rowHeight: number;
  active: boolean;
  selected: boolean;
  onPointerDown: () => void;
}

export const FileListEntryRow = memo(function FileListEntryRow({ item, rowHeight, active, selected, onPointerDown }: FileListEntryRowProps) {
  const { entry, style } = item;
  const executable = entry.type === "file" && !!(entry.meta as { executable?: boolean }).executable;
  const hidden = !!entry.meta.hidden;

  return (
    <div
      className={cx(styles, "entry", active && "selected", selected && "marked")}
      style={{ height: rowHeight, opacity: style.opacity }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown();
      }}
    >
      <span className={styles["entry-icon"]}>
        <FileIcon path={entry.path as string} isDirectory={entry.type === "folder"} langId={entry.lang} hidden={hidden} executable={executable} size={16} />
      </span>
      <span
        className={styles["entry-name"]}
        style={{
          color: style.color,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          fontStretch: style.fontStretch,
          fontVariant: style.fontVariant,
          textDecoration: style.textDecoration,
        }}
      >
        {entry.name}
      </span>
      {"size" in entry.meta && entry.type === "file" && <span className={styles["entry-size"]}>{formatSize(entry.meta.size)}</span>}
    </div>
  );
});
