const OPEN_VSX_MARKETPLACE_URL = "https://open-vsx.org";

export interface OpenVsxExtension {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  downloadCount: number;
  files?: {
    download?: string;
    icon?: string;
  };
}

interface OpenVsxSearchResult {
  offset: number;
  totalSize: number;
  extensions: OpenVsxExtension[];
}

export async function searchOpenVsxMarketplace(
  query: string,
  page = 1,
): Promise<{ extensions: OpenVsxExtension[]; total: number }> {
  const pageSize = 30;
  const params = new URLSearchParams({
    size: String(pageSize),
    offset: String((page - 1) * pageSize),
  });
  if (query) params.set("query", query);

  const res = await fetch(
    `${OPEN_VSX_MARKETPLACE_URL}/api/-/search?${params.toString()}`,
  );

  if (!res.ok) throw new Error("Open VSX marketplace request failed");
  const data: OpenVsxSearchResult = await res.json();
  return {
    extensions: data.extensions ?? [],
    total: data.totalSize ?? 0,
  };
}

export function getOpenVsxDownloadUrl(ext: OpenVsxExtension): string | null {
  return ext.files?.download ?? null;
}

export function getOpenVsxIconUrl(ext: OpenVsxExtension): string | null {
  return ext.files?.icon ?? null;
}
