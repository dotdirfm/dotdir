import { useEffect } from "react";
import styles from "./FileIcon.module.css";
import { useIconAssetUrl } from "./iconCache";
import { useLoadIconsForPaths, type ResolvedIcon } from "./iconResolver";

interface FileIconProps {
  icon: ResolvedIcon;
  size?: number;
  className?: string;
}

export function FileIcon({ icon, size = 16, className }: FileIconProps) {
  const loadIconsForPaths = useLoadIconsForPaths();
  const imageUrl = useIconAssetUrl(icon.kind === "image" ? icon.path : null);

  useEffect(() => {
    const resolvedThemeIcon =
      icon.kind === "image" && icon.path
        ? [{ kind: "image" as const, path: icon.path }]
        : icon.kind === "font" && icon.font
          ? [
              {
                kind: "font" as const,
                character: icon.font.character,
                fontFamily: icon.font.fontFamily,
                color: icon.font.color,
                fontSize: icon.font.fontSize,
              },
            ]
          : [];
    if (resolvedThemeIcon.length === 0) return;
    void loadIconsForPaths(resolvedThemeIcon);
  }, [icon, loadIconsForPaths]);

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
        <img className={styles.image} src={imageUrl ?? icon.url ?? icon.fallbackUrl} width={size} height={size} alt="" />
      )}
    </span>
  );
}
