/**
 * Helpers for detecting image/video files (used for viewer gallery and focus).
 * Viewer implementations live in extensions (e.g. faraday-image-viewer).
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'tiff', 'tif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v']);

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExt(name));
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(getExt(name));
}

export function isMediaFile(name: string): boolean {
  return isImageFile(name) || isVideoFile(name);
}
