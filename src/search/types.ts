// The agent's one tool, behind an interface so the provider can be swapped (or faked in tests).

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Publication or last-updated date if the provider knows it (ISO date). */
  publishedDate?: string;
  /** Provider relevance score, 0-1 if available. */
  score?: number;
}

export interface SearchOptions {
  maxResults?: number;
  /** Only results from the last N days (news-style search). */
  sinceDays?: number;
  /** "basic" is fast; "deep" spends more time for better snippets (used for re-verification). */
  depth?: "basic" | "deep";
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** Optional: answer several queries in one round trip (one result list per query, in order). */
  searchBatch?(items: Array<{ query: string; opts?: SearchOptions }>, signal?: AbortSignal): Promise<SearchResult[][]>;
}
