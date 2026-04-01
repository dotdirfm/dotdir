import styles from "./ActionBar.module.css";

export function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className={styles["action-bar"]}>{children}</div>;
}
