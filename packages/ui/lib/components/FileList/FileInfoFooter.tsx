import { FsNode } from "fss-lang";
import styles from "./FileList.module.css";

function formatSize(sizeValue: unknown): string {
  let size: number;
  if (typeof sizeValue === "number") size = sizeValue;
  else if (typeof sizeValue === "bigint") size = Number(sizeValue);
  else return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} K`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} M`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FileInfoFooter({ entry }: { entry?: FsNode }) {
  const footerName = entry?.name ?? "";
  const footerDate = entry ? formatDate(Number(entry.meta.mtimeMs ?? 0)) : "";
  const footerInfo = (() => {
    if (!entry) return "";
    if (entry.name === "..") return "Up";
    const kind: string = (entry.meta.entryKind as string | undefined) ?? (entry.type === "folder" ? "directory" : "file");
    const nlink: number = (entry.meta.nlink as number | undefined) ?? 1;
    switch (kind) {
      case "directory":
        return nlink > 1 ? `DIR [${nlink}]` : "DIR";
      case "symlink":
        return "";
      case "block_device":
        return "BLK DEV";
      case "char_device":
        return "CHR DEV";
      case "named_pipe":
        return "FIFO";
      case "socket":
        return "SOCK";
      case "whiteout":
        return "WHT";
      case "door":
        return "DOOR";
      case "event_port":
        return "EVT PORT";
      case "unknown":
        return "?";
      default: {
        const s = formatSize(entry.meta.size);
        return nlink > 1 ? `${s} [${nlink}]` : s;
      }
    }
  })();
  const footerLink = (() => {
    if (!entry) return "";
    const kind: string = (entry.meta.entryKind as string | undefined) ?? "";
    if (kind !== "symlink") return "";
    const target = entry.meta.linkTarget as string | undefined;
    return `\u2192 ${target ?? "?"}`;
  })();

  return (
    <div className={styles["file-info-footer"]}>
      <span className={styles["file-info-name"]}>{footerName}</span>
      {footerLink && <span className={styles["file-info-link"]}>{footerLink}</span>}
      <span className={styles["file-info-size"]}>{footerInfo}</span>
      <span className={styles["file-info-date"]}>{footerDate}</span>
    </div>
  );
}
