import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { cx } from "@/utils/cssModules";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useEffect, useRef, useState } from "react";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface OpenCreateFileDialogProps {
  currentPath: string;
  onConfirm: (filePath: string, fileName: string, langId: string) => void;
  onCancel: () => void;
}

export function OpenCreateFileDialog({ currentPath, onConfirm, onCancel }: OpenCreateFileDialogProps) {
  const languageRegistry = useLanguageRegistry();
  const inputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState("");
  const [langId, setLangId] = useState("plaintext");
  const [userTouchedLanguage, setUserTouchedLanguage] = useState(false);

  // Suggest language from filename when filename changes (only if user hasn't touched the dropdown)
  useEffect(() => {
    if (userTouchedLanguage || !filename.trim()) return;
    const suggested = languageRegistry.getLanguageForFilename(filename.trim());
    setLangId(suggested);
  }, [filename, languageRegistry, userTouchedLanguage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = filename.trim();
    if (!name) return;
    const path = currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name;
    onConfirm(path, name, langId);
  };

  return (
    <OverlayDialog className={cx(styles, "modal-dialog", "open-create-file-dialog")} onClose={onCancel} initialFocusRef={inputRef}>
      <div className={styles["modal-dialog-header"]}>Open / Create File</div>
      <form className={styles["open-create-file-form"]} onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["open-create-file-field"]}>
            <label htmlFor="open-create-filename">
              <SmartLabel>Filename</SmartLabel>
            </label>
            <input
              ref={inputRef}
              id="open-create-filename"
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="e.g. script.js"
              aria-describedby="open-create-file-hint"
              {...INPUT_NO_ASSIST}
            />
            <span id="open-create-file-hint" className={styles["open-create-file-hint"]}>
              File will be created in the current panel directory if it does not exist.
            </span>
          </div>
          <div className={styles["open-create-file-field"]}>
            <label htmlFor="open-create-language">
              <SmartLabel>Language</SmartLabel>
            </label>
            <select
              id="open-create-language"
              value={langId}
              onChange={(e) => {
                setLangId(e.target.value);
                setUserTouchedLanguage(true);
              }}
            >
              <option value="plaintext">Plain Text</option>
              {languageRegistry.options.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={styles["modal-dialog-buttons"]}>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!filename.trim()}>
            <SmartLabel>OK</SmartLabel>
          </button>
        </div>
      </form>
    </OverlayDialog>
  );
}
