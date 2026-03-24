/**
 * VS Code Marketplace API and VSIX support
 */

const VSCODE_MARKETPLACE_URL = "https://marketplace.visualstudio.com/_apis/public/gallery";

export interface VSCodeExtension {
  publisher: { publisherName: string; displayName: string };
  extensionName: string;
  displayName: string;
  shortDescription: string;
  versions: { version: string; assetUri: string }[];
  statistics: { statisticName: string; value: number }[];
}

export interface VSCodeSearchResult {
  results: { extensions: VSCodeExtension[] }[];
}

export async function searchVSCodeMarketplace(query: string, page = 1): Promise<{ extensions: VSCodeExtension[]; total: number }> {
  const pageSize = 30;
  const body = {
    filters: [
      {
        criteria: [{ filterType: 8, value: "Microsoft.VisualStudio.Code" }, ...(query ? [{ filterType: 10, value: query }] : [])],
        pageNumber: page,
        pageSize,
        sortBy: query ? 0 : 4, // 0 = relevance, 4 = install count
        sortOrder: 0,
      },
    ],
    assetTypes: [],
    flags: 914, // Include statistics, versions, files
  };

  const res = await fetch(`${VSCODE_MARKETPLACE_URL}/extensionquery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json;api-version=7.1-preview.1",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error("VS Code marketplace request failed");
  const data: VSCodeSearchResult = await res.json();
  const extensions = data.results?.[0]?.extensions ?? [];
  return { extensions, total: extensions.length };
}

export function getVSCodeInstallCount(ext: VSCodeExtension): number {
  const stat = ext.statistics?.find((s) => s.statisticName === "install");
  return stat?.value ?? 0;
}

export function getVSCodeLatestVersion(ext: VSCodeExtension): string | null {
  return ext.versions?.[0]?.version ?? null;
}

export function getVSCodeDownloadUrl(ext: VSCodeExtension): string | null {
  const version = ext.versions?.[0];
  if (!version) return null;
  return `${version.assetUri}/Microsoft.VisualStudio.Services.VSIXPackage`;
}

export function getVSCodeIconUrl(ext: VSCodeExtension): string | null {
  const version = ext.versions?.[0];
  if (!version) return null;
  return `${version.assetUri}/Microsoft.VisualStudio.Services.Icons.Default`;
}
