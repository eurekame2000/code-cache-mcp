import { createHash } from "crypto";

// Lazy-loaded Anthropic client — only if @anthropic-ai/sdk is installed and ANTHROPIC_API_KEY is set.
// Fallback: chars / 4 (≈4 chars per token, close to Claude tokenizer on code).
export class TokenTracker {
  private clientPromise?: Promise<unknown>;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly cache = new Map<string, number>();
  private static readonly CACHE_MAX = 500;

  constructor(apiKey?: string, model = "claude-sonnet-4-6") {
    this.apiKey = apiKey;
    this.model = model;
  }

  /** Fast synchronous estimate: chars / 4. */
  static estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** True iff API key is set and SDK is importable (checked lazily). */
  get hasAccurateCounter(): boolean {
    return !!this.apiKey;
  }

  private getClient(): Promise<unknown> {
    if (!this.clientPromise) {
      if (!this.apiKey) {
        this.clientPromise = Promise.resolve(undefined);
      } else {
        // @ts-ignore — optional dep; runtime resolves if installed
        this.clientPromise = import("@anthropic-ai/sdk")
          .then((m: any) => new m.default({ apiKey: this.apiKey }))
          .catch(() => undefined);
      }
    }
    return this.clientPromise!;
  }

  /**
   * Count tokens for `text`. Uses Anthropic count_tokens API when available,
   * falls back to char-based estimate. Result is cached by content hash.
   */
  async count(text: string): Promise<number> {
    const key = createHash("md5").update(text).digest("hex");
    if (this.cache.has(key)) return this.cache.get(key)!;

    let result: number;
    const client = await this.getClient() as any;
    if (client) {
      try {
        const resp = await client.messages.count_tokens({
          model: this.model,
          messages: [{ role: "user", content: text }],
        });
        result = resp.input_tokens as number;
      } catch {
        result = TokenTracker.estimate(text);
      }
    } else {
      result = TokenTracker.estimate(text);
    }

    if (this.cache.size >= TokenTracker.CACHE_MAX) {
      // Evict oldest entry — Map preserves insertion order
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, result);
    return result;
  }
}
