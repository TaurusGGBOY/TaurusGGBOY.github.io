export const QUEUE_STORAGE_KEY = "gaoguobin-reading-queue";

export function serializeQueuedSlugs(slugs: string[]): string {
  return JSON.stringify(uniqueSafeSlugs(slugs));
}

export function deserializeQueuedSlugs(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return [];
    }

    return uniqueSafeSlugs(parsed);
  } catch {
    return [];
  }
}

export function addQueuedSlug(slugs: string[], slug: string): string[] {
  return uniqueSafeSlugs([...slugs, slug]);
}

export function removeQueuedSlug(slugs: string[], slug: string): string[] {
  return uniqueSafeSlugs(slugs).filter((item) => item !== slug);
}

function uniqueSafeSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const slug of slugs) {
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
