export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  if ("userAgentData" in navigator && (navigator as any).userAgentData) {
    return (navigator as any).userAgentData.platform === "macOS";
  }
  return /mac/i.test(navigator.platform);
}

export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  if ("userAgentData" in navigator && (navigator as any).userAgentData) {
    return (navigator as any).userAgentData.platform === "Windows";
  }
  return /win/i.test(navigator.platform);
}
