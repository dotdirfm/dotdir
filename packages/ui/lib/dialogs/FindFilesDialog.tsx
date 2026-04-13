import type { FileSearchRequest } from "@/features/bridge";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useMemo, useRef, useState } from "react";
import { PathAutocompleteInput } from "./PathAutocompleteInput";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";
import { useDialogButtonNav } from "./useDialogButtonNav";

export interface FindFilesDialogProps {
  initialRequest: FileSearchRequest;
  suggestionRoots: Array<{ id: string; label: string; path: string }>;
  onConfirm: (request: FileSearchRequest) => void;
  onCancel: () => void;
  stackIndex?: number;
}

function formatIgnoreDirs(value: string[]): string {
  return value.join("; ");
}

function parseIgnoreDirs(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function FindFilesDialog({
  initialRequest,
  suggestionRoots,
  onConfirm,
  onCancel,
  stackIndex = 0,
}: FindFilesDialogProps) {
  const buttonsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onKeyDown } = useDialogButtonNav(buttonsRef, { defaultIndex: 0 });

  const [startPath, setStartPath] = useState(initialRequest.startPath);
  const [ignoreDirsEnabled, setIgnoreDirsEnabled] = useState(initialRequest.ignoreDirsEnabled);
  const [ignoreDirsText, setIgnoreDirsText] = useState(formatIgnoreDirs(initialRequest.ignoreDirs));
  const [filePattern, setFilePattern] = useState(initialRequest.filePattern);
  const [contentPattern, setContentPattern] = useState(initialRequest.contentPattern);
  const [recursive, setRecursive] = useState(initialRequest.recursive);
  const [followSymlinks, setFollowSymlinks] = useState(initialRequest.followSymlinks);
  const [shellPatterns, setShellPatterns] = useState(initialRequest.shellPatterns);
  const [caseSensitiveFileName, setCaseSensitiveFileName] = useState(initialRequest.caseSensitiveFileName);
  const [wholeWords, setWholeWords] = useState(initialRequest.wholeWords);
  const [regex, setRegex] = useState(initialRequest.regex);
  const [caseSensitiveContent, setCaseSensitiveContent] = useState(initialRequest.caseSensitiveContent);
  const [allCharsets, setAllCharsets] = useState(initialRequest.allCharsets);
  const [firstHit, setFirstHit] = useState(initialRequest.firstHit);
  const [skipHidden, setSkipHidden] = useState(initialRequest.skipHidden);

  const canSubmit = useMemo(() => startPath.trim().length > 0, [startPath]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onConfirm({
      startPath: startPath.trim(),
      ignoreDirsEnabled,
      ignoreDirs: ignoreDirsEnabled ? parseIgnoreDirs(ignoreDirsText) : [],
      filePattern: filePattern.trim() || "*",
      // Preserve leading/trailing whitespace for content search (important for regex patterns like " *The").
      contentPattern,
      recursive,
      followSymlinks,
      shellPatterns,
      caseSensitiveFileName,
      wholeWords,
      regex,
      caseSensitiveContent,
      allCharsets,
      firstHit,
      skipHidden,
    });
  };

  return (
    <OverlayDialog className={styles["find-files-dialog"]} onClose={onCancel} onKeyDown={onKeyDown} initialFocusRef={inputRef} stackIndex={stackIndex}>
      <div className={styles["modal-dialog-header"]}>Find File</div>
      <form className={styles["modal-dialog-form"]} onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["find-files-start-row"]}>
            <div className={styles["find-files-field"]}>
              <label htmlFor="find-files-start">
                <SmartLabel>Start at</SmartLabel>
              </label>
              <PathAutocompleteInput
                id="find-files-start"
                value={startPath}
                onChange={setStartPath}
                roots={suggestionRoots}
                mode="directories"
                inputRef={inputRef}
                inputClassName={styles["dialog-input"]}
                {...INPUT_NO_ASSIST}
              />
            </div>
          </div>

          <div className={styles["find-files-ignore-row"]}>
            <label className={styles["find-files-checkbox"]}>
              <input
                type="checkbox"
                checked={ignoreDirsEnabled}
                onChange={(event) => setIgnoreDirsEnabled(event.target.checked)}
              />
              <SmartLabel>Enable ignore directories</SmartLabel>
            </label>
            <input
              type="text"
              value={ignoreDirsText}
              onChange={(event) => setIgnoreDirsText(event.target.value)}
              disabled={!ignoreDirsEnabled}
              placeholder=".git; node_modules; dist"
              {...INPUT_NO_ASSIST}
            />
          </div>

          <div className={styles["find-files-search-grid"]}>
            <div className={styles["find-files-field"]}>
              <label htmlFor="find-files-name">
                <SmartLabel>File name</SmartLabel>
              </label>
              <input
                id="find-files-name"
                type="text"
                value={filePattern}
                onChange={(event) => setFilePattern(event.target.value)}
                {...INPUT_NO_ASSIST}
              />
            </div>
            <div className={styles["find-files-field"]}>
              <label htmlFor="find-files-content">
                <SmartLabel>Content</SmartLabel>
              </label>
              <input
                id="find-files-content"
                type="text"
                value={contentPattern}
                onChange={(event) => setContentPattern(event.target.value)}
                {...INPUT_NO_ASSIST}
              />
            </div>
          </div>

          <div className={styles["find-files-options-grid"]}>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
              <SmartLabel>Find recursively</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={wholeWords} onChange={(event) => setWholeWords(event.target.checked)} />
              <SmartLabel>Whole words</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={followSymlinks} onChange={(event) => setFollowSymlinks(event.target.checked)} />
              <SmartLabel>Follow symlinks</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />
              <SmartLabel>Regular expression</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={shellPatterns} onChange={(event) => setShellPatterns(event.target.checked)} />
              <SmartLabel>Using shell patterns</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input
                type="checkbox"
                checked={caseSensitiveFileName}
                onChange={(event) => setCaseSensitiveFileName(event.target.checked)}
              />
              <SmartLabel>Case sensitive name</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input
                type="checkbox"
                checked={caseSensitiveContent}
                onChange={(event) => setCaseSensitiveContent(event.target.checked)}
              />
              <SmartLabel>Case sensitive content</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={allCharsets} onChange={(event) => setAllCharsets(event.target.checked)} />
              <SmartLabel>All charsets</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={firstHit} onChange={(event) => setFirstHit(event.target.checked)} />
              <SmartLabel>First hit</SmartLabel>
            </label>
            <label className={styles["find-files-checkbox"]}>
              <input type="checkbox" checked={skipHidden} onChange={(event) => setSkipHidden(event.target.checked)} />
              <SmartLabel>Skip hidden</SmartLabel>
            </label>
          </div>
        </div>
        <div className={styles["modal-dialog-buttons"]} ref={buttonsRef}>
          <button type="submit" disabled={!canSubmit}>
            <SmartLabel>OK</SmartLabel>
          </button>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
        </div>
      </form>
    </OverlayDialog>
  );
}
