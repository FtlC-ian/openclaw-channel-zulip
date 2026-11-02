// Supported hosts publish this runtime subpath without a declaration file.
declare module "openclaw/plugin-sdk/outbound-media" {
  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: {
      maxBytes?: number;
      mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
        workspaceDir?: string;
      };
      mediaLocalRoots?: readonly string[] | "any";
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
      workspaceDir?: string;
      proxyUrl?: string;
      fetchImpl?: typeof fetch;
      requestInit?: RequestInit;
      optimizeImages?: boolean;
      trustExplicitProxyDns?: boolean;
    },
  ): Promise<import("openclaw/plugin-sdk/web-media").WebMediaResult>;
}
