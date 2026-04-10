import { DEFAULT_ICONS } from "./defaultIcons";
import styles from "./FileIcon.module.css";

interface FallbackFileIconProps {
  isDirectory: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

export function FallbackFileIcon({ isDirectory, isOpen, size = 16, className }: FallbackFileIconProps) {
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  return (
    <span className={rootClassName} style={{ width: size, height: size }}>
      {isDirectory && !isOpen && <img className={styles.image} src={DEFAULT_ICONS.folder} width={size} height={size} alt="" />}
      {isDirectory && isOpen && <img className={styles.image} src={DEFAULT_ICONS.folderOpen} width={size} height={size} alt="" />}
      {!isDirectory && <img className={styles.image} src={DEFAULT_ICONS.file} width={size} height={size} alt="" />}
    </span>
  );
}
