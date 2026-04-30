export interface BM25Document {
  id: string;
  text: string; // all searchable text concatenated
}

export interface BM25Result {
  id: string;
  score: number;
}

export class BM25Index {
  private docs: Map<string, { terms: Map<string, number>; length: number }>;
  private df: Map<string, number>; // document frequency per term
  private avgdl: number;
  private N: number;
  private k1 = 1.5;
  private b = 0.75;

  constructor(documents: BM25Document[]) {
    this.docs = new Map();
    this.df = new Map();
    this.N = documents.length;

    let totalLength = 0;

    for (const doc of documents) {
      const terms = this.tokenize(doc.text);
      const termFreq = new Map<string, number>();
      for (const term of terms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      this.docs.set(doc.id, { terms: termFreq, length: terms.length });
      totalLength += terms.length;

      // Update document frequency
      for (const term of termFreq.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }

    this.avgdl = this.N > 0 ? totalLength / this.N : 0;
  }

  search(query: string, limit = 20, minScore = 0): BM25Result[] {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const results: BM25Result[] = [];

    for (const [id, doc] of this.docs) {
      let score = 0;
      for (const qt of queryTerms) {
        const tf = doc.terms.get(qt) ?? 0;
        if (tf === 0) continue;

        const n = this.df.get(qt) ?? 0;
        const idf = Math.log((this.N - n + 0.5) / (n + 0.5) + 1);
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgdl));
        score += idf * tfNorm;
      }
      if (score >= minScore && score > 0) {
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ') // keep CJK chars
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}
