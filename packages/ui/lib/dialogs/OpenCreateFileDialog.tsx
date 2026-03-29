import { focusContext } from "@/focusContext";
import { languageRegistry } from "@/languageRegistry";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useEffect, useRef, useState } from "react";
import { SmartLabel } from "./dialogHotkeys";

export interface LanguageOption {
  id: string;
  label: string;
}

export interface OpenCreateFileDialogProps {
  currentPath: string;
  languages: LanguageOption[];
  onConfirm: (filePath: string, fileName: string, langId: string) => void;
  onCancel: () => void;
}

export function OpenCreateFileDialog({ currentPath, languages, onConfirm, onCancel }: OpenCreateFileDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState("");
  const [langId, setLangId] = useState("plaintext");
  const [userTouchedLanguage, setUserTouchedLanguage] = useState(false);

  // Suggest language from filename when filename changes (only if user hasn't touched the dropdown)
  useEffect(() => {
    if (userTouchedLanguage || !filename.trim()) return;
    const suggested = languageRegistry.getLanguageForFilename(filename.trim());
    setLangId(suggested);
  }, [filename, userTouchedLanguage]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push("modal");
    inputRef.current?.focus();
    const handleClose = () => onCancel();
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      focusContext.pop("modal");
    };
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = filename.trim();
    if (!name) return;
    const path = currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name;
    dialogRef.current?.close();
    onConfirm(path, name, langId);
  };

  const handleCancel = () => {
    dialogRef.current?.close();
    onCancel();
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog open-create-file-dialog" onCancel={handleCancel}>
      <div className="modal-dialog-header">Open / Create File</div>
      <form className="open-create-file-form" onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="open-create-file-field">
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
            <span id="open-create-file-hint" className="open-create-file-hint">
              File will be created in the current panel directory if it does not exist.
            </span>
          </div>
          <div className="open-create-file-field">
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
              {languages.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="modal-dialog-buttons">
          <button type="button" onClick={handleCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!filename.trim()}>
            <SmartLabel>OK</SmartLabel>
          </button>
        </div>
      </form>
    </dialog>
  );
}
