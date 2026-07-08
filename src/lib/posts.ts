export type PostSummary = {
  slug: string;
  title: string;
  date: Date;
  summary: string;
  tags: string[];
  featured: boolean;
  readTime: string;
  href: string;
};

export type TopicSummary = {
  name: string;
  count: number;
};

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function getSortedPosts(posts: PostSummary[]): PostSummary[] {
  return [...posts].sort((left, right) => {
    if (left.featured !== right.featured) {
      return left.featured ? -1 : 1;
    }

    return right.date.getTime() - left.date.getTime();
  });
}

export function getTopics(posts: PostSummary[]): TopicSummary[] {
  const counts = new Map<string, number>();

  for (const post of posts) {
    const postTopics = new Set<string>();

    for (const tag of post.tags) {
      const normalizedTag = normalizeTag(tag);
      if (normalizedTag) {
        postTopics.add(normalizedTag);
      }
    }

    for (const topic of postTopics) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function filterPostsByTopic(posts: PostSummary[], topic: string): PostSummary[] {
  const normalizedTopic = normalizeTag(topic);
  if (!normalizedTopic) {
    return posts;
  }

  return posts.filter((post) =>
    post.tags.some((tag) => normalizeTag(tag) === normalizedTopic),
  );
}

export function searchPosts(posts: PostSummary[], query: string): PostSummary[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return posts;
  }

  return posts.filter((post) => {
    const haystack = [
      post.title,
      post.summary,
      post.tags.join(" "),
    ].join(" ").toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}
