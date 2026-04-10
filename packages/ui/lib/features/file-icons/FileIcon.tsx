import { createFileStyleNode, useFileStyleResolver } from "@/features/fss/fileStyleResolver";
import { useEffect, useMemo } from "react";
import styles from "./FileIcon.module.css";
import { useGetCachedIcon, useResolveIcon } from "./iconResolver";

interface FileIconProps {
  path: string;
  isDirectory: boolean;
  langId?: string;
  hidden?: boolean;
  executable?: boolean;
  size?: number;
  className?: string;
}

export function FileIcon({ path, isDirectory, langId, hidden, executable, size = 16, className }: FileIconProps) {
  const { resolve, registerResolvedIcon, assetVersion } = useFileStyleResolver();
  const resolveIcon = useResolveIcon();
  const getCachedIcon = useGetCachedIcon();
  const node = useMemo(
    () =>
      createFileStyleNode({
        path,
        isDirectory,
        langId,
        hidden,
        executable,
      }),
    [executable, hidden, isDirectory, langId, path],
  );
  const style = resolve(node);
  const icon = resolveIcon(node.name, isDirectory, false, false, langId, style.icon);
  const iconRegistrationKey = useMemo(() => {
    if (icon.kind === "image") {
      return `image:${icon.path ?? "_default"}`;
    }
    if (icon.font) {
      return `font:${icon.font.fontFamily}:${icon.font.character}:${icon.font.color ?? ""}:${icon.font.fontSize ?? ""}`;
    }
    return "font:_missing";
  }, [icon]);

  useEffect(() => registerResolvedIcon(icon), [iconRegistrationKey, registerResolvedIcon]);

  const imageUrl = useMemo(() => {
    if (icon.kind !== "image") return null;
    if (!icon.path) return icon.url ?? icon.fallbackUrl;
    return getCachedIcon(icon.path) ?? icon.url ?? icon.fallbackUrl;
  }, [assetVersion, getCachedIcon, icon]);

  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  return (
    <span className={rootClassName} style={{ width: size, height: size }}>
      {icon.kind === "font" && icon.font ? (
        <span
          className={styles.font}
          style={{
            width: size,
            height: size,
            fontFamily: icon.font.fontFamily,
            fontSize: icon.font.fontSize,
            color: icon.font.color,
          }}
          aria-hidden="true"
        >
          {icon.font.character}
        </span>
      ) : (
        <img className={styles.image} src={imageUrl ?? icon.fallbackUrl} width={size} height={size} alt="" />
      )}
    </span>
  );
}
