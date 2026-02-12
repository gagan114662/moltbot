/**
 * ContextStore — append-only JSONL store with queryable metadata.
 *
 * Storage: one JSONL file per (domain, scopeKey) pair.
 * Location: ~/.openclaw/context/{domain}/{scopeKey-hash}.jsonl
 *
 * Design:
 * - JSONL over SQLite: simpler, no native deps, grep-friendly
 * - File-per-scope: natural partitioning, easy cleanup
 * - Append-only: no corruption risk from concurrent writers
 * - In-memory index: rebuilt lazily on first query per scope
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextDomain, ContextMeta, ContextQuery, ContextRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashScopeKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Estimate tokens from a string (rough: chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// ContextStore
// ---------------------------------------------------------------------------

export class ContextStore {
  private baseDir: string;
  /** In-memory cache: filePath → records. Lazily populated. */
  private cache = new Map<string, ContextRecord[]>();
  /** Monotonic counter for stable ordering. */
  private seq = 0;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".openclaw", "context");
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private domainDir(domain: ContextDomain): string {
    return path.join(this.baseDir, domain);
  }

  private scopeFile(domain: ContextDomain, scopeKey: string): string {
    return path.join(this.domainDir(domain), `${hashScopeKey(scopeKey)}.jsonl`);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Load records from a JSONL file, skipping corrupt lines. */
  private loadFile(filePath: string): ContextRecord[] {
    if (this.cache.has(filePath)) {
      return this.cache.get(filePath)!;
    }

    if (!fs.existsSync(filePath)) {
      const empty: ContextRecord[] = [];
      this.cache.set(filePath, empty);
      return empty;
    }

    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const records: ContextRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as ContextRecord);
      } catch {
        // Skip corrupt lines silently
      }
    }
    this.cache.set(filePath, records);
    return records;
  }

  /** Load all records for a domain (across all scopes). */
  private loadDomain(domain: ContextDomain): ContextRecord[] {
    const dir = this.domainDir(domain);
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const all: ContextRecord[] = [];
    for (const file of files) {
      all.push(...this.loadFile(path.join(dir, file)));
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** Append a record. Returns the generated ID. */
  append<T>(domain: ContextDomain, scopeKey: string, payload: T, tags?: string[]): string {
    const id = generateId();
    const payloadStr = JSON.stringify(payload);
    const meta: ContextMeta = {
      id,
      domain,
      timestamp: Date.now(),
      tags: tags ?? [],
      scopeKey,
      estimatedTokens: estimateTokens(payloadStr),
      seq: this.seq++,
    };
    const record: ContextRecord<T> = { meta, payload };

    const filePath = this.scopeFile(domain, scopeKey);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");

    // Invalidate cache for this file
    this.cache.delete(filePath);

    return id;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Query records matching the given criteria. */
  query(filter: ContextQuery): ContextRecord[] {
    let records: ContextRecord[];

    // Narrow the search space
    if (filter.scopeKey && filter.domain && !Array.isArray(filter.domain)) {
      records = this.loadFile(this.scopeFile(filter.domain, filter.scopeKey));
    } else if (filter.domain) {
      const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain];
      records = domains.flatMap((d) => this.loadDomain(d));
    } else {
      // All domains
      const allDomains: ContextDomain[] = ["chat", "qa-iteration", "overnight-cycle"];
      records = allDomains.flatMap((d) => this.loadDomain(d));
    }

    // Apply filters
    let filtered = records;

    if (filter.scopeKey) {
      filtered = filtered.filter((r) => r.meta.scopeKey === filter.scopeKey);
    }

    if (filter.tags && filter.tags.length > 0) {
      filtered = filtered.filter((r) => filter.tags!.every((t) => r.meta.tags.includes(t)));
    }

    if (filter.after !== undefined) {
      filtered = filtered.filter((r) => r.meta.timestamp > filter.after!);
    }

    if (filter.before !== undefined) {
      filtered = filtered.filter((r) => r.meta.timestamp < filter.before!);
    }

    if (filter.textSearch) {
      const search = filter.textSearch.toLowerCase();
      filtered = filtered.filter((r) => JSON.stringify(r.payload).toLowerCase().includes(search));
    }

    // Sort (use seq as tiebreaker for stable ordering within same timestamp)
    const order = filter.order ?? "newest";
    filtered.sort((a, b) => {
      const timeDiff =
        order === "newest"
          ? b.meta.timestamp - a.meta.timestamp
          : a.meta.timestamp - b.meta.timestamp;
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return order === "newest" ? b.meta.seq - a.meta.seq : a.meta.seq - b.meta.seq;
    });

    // Limit
    if (filter.limit !== undefined && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  /** Count records matching criteria (loads records but only returns count). */
  count(filter: ContextQuery): number {
    return this.query({ ...filter, limit: undefined }).length;
  }

  /** Get a single record by ID. */
  get(id: string): ContextRecord | null {
    // Brute-force search across all domains (rare operation)
    const allDomains: ContextDomain[] = ["chat", "qa-iteration", "overnight-cycle"];
    for (const domain of allDomains) {
      const records = this.loadDomain(domain);
      const found = records.find((r) => r.meta.id === id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Delete records older than a given timestamp for a scope. Returns count deleted. */
  prune(domain: ContextDomain, scopeKey: string, olderThanMs: number): number {
    const filePath = this.scopeFile(domain, scopeKey);
    const records = this.loadFile(filePath);
    const cutoff = Date.now() - olderThanMs;
    const kept = records.filter((r) => r.meta.timestamp >= cutoff);
    const pruned = records.length - kept.length;

    if (pruned > 0) {
      const content = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : "");
      fs.writeFileSync(filePath, content);
      this.cache.delete(filePath);
    }

    return pruned;
  }

  /** List all scope keys for a domain. */
  listScopes(domain: ContextDomain): string[] {
    const dir = this.domainDir(domain);
    if (!fs.existsSync(dir)) {
      return [];
    }
    // We can't reverse the hash, so we return the scope keys from loaded records
    const records = this.loadDomain(domain);
    const keys = new Set(records.map((r) => r.meta.scopeKey));
    return [...keys];
  }

  /** Clear the in-memory cache (useful for testing). */
  clearCache(): void {
    this.cache.clear();
  }
}
