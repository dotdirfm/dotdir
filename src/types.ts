export type EntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'block_device'
  | 'char_device'
  | 'named_pipe'
  | 'socket'
  | 'whiteout'
  | 'door'
  | 'event_port'
  | 'unknown';

export interface FsaRawEntry {
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  hidden: boolean;
  /** Populated only when kind === 'symlink'. */
  linkTarget?: string;
}

export type FsChangeType = 'appeared' | 'disappeared' | 'modified' | 'errored' | 'unknown';

export interface FsChangeEvent {
  watchId: string;
  type: FsChangeType;
  name: string | null;
}

export interface ResolvedEntryStyle {
  color?: string;
  opacity?: number;
  icon: string | null;
  sortPriority: number;
  groupFirst: boolean;
}
