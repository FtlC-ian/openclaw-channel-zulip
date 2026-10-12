export function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
  groupFallback?: string;
}): string {
  if (params.isGroup) {
    const label = params.groupLabel?.trim() || params.groupFallback || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }

  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) {
    return directLabel;
  }
  return `${directLabel} id:${directId}`;
}

type DedupeCache = {
  clearPrefix: (prefix: string) => void;
  check: (key: string | undefined | null, now?: number) => boolean;
};

export function createDedupeCache(options: { ttlMs: number; maxSize: number }): DedupeCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxSize = Math.max(0, Math.floor(options.maxSize));
  const cache = new Map<string, number>();

  const touch = (key: string, now: number) => {
    cache.delete(key);
    cache.set(key, now);
  };

  const prune = (now: number) => {
    const cutoff = ttlMs > 0 ? now - ttlMs : undefined;
    if (cutoff !== undefined) {
      for (const [entryKey, entryTs] of cache) {
        if (entryTs < cutoff) {
          cache.delete(entryKey);
        }
      }
    }
    if (maxSize <= 0) {
      cache.clear();
      return;
    }
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  return {
    clearPrefix: (prefix) => {
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
    check: (key, now = Date.now()) => {
      if (!key) {
        return false;
      }
      const existing = cache.get(key);
      if (existing !== undefined && (ttlMs <= 0 || now - existing < ttlMs)) {
        touch(key, now);
        return true;
      }
      touch(key, now);
      prune(now);
      return false;
    },
  };
}
