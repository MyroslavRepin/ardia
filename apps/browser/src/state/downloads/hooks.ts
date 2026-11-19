import { useMemo } from "react";
import { useBrowser } from "../browser/store";
import { useDownloadProgress, withProgress } from "./progress";
import { useContentNames } from "./contentNames";

export function useDownload(id: string) {
  const download = useBrowser((s) => s.downloads.find((d) => d.id === id));
  const progress = useDownloadProgress((s) => s[id]);
  return useMemo(() => withProgress(download, progress), [download, progress]);
}

export const useContentName = (id: string) => useContentNames((s) => s.names[id]);
export const useNamingByContent = (id: string) => useContentNames((s) => !!s.thinking[id]);
