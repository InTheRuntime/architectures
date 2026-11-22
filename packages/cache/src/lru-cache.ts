/**
 * Doubly Linked List Node holding key, value, and expiration timestamp.
 */
class CacheNode<K, V> {
  public key: K;
  public value: V;
  public expiresAtMs: number | null;
  public prev: CacheNode<K, V> | null = null;
  public next: CacheNode<K, V> | null = null;

  constructor(key: K, value: V, expiresAtMs: number | null = null) {
    this.key = key;
    this.value = value;
    this.expiresAtMs = expiresAtMs;
  }

  public isExpired(nowMs: number): boolean {
    return this.expiresAtMs !== null && nowMs > this.expiresAtMs;
  }
}

export interface CacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  hitRatio: number;
}

export interface LruCacheOptions {
  capacity: number;
  defaultTtlMs?: number;
}

/**
 * High-performance O(1) LRU (Least Recently Used) Cache with TTL support.
 *
 * Combines a Hash Map (for O(1) key lookups) with a Doubly Linked List
 * (for O(1) node detachment and head insertion).
 */
export class LruCache<K, V> {
  public readonly capacity: number;
  public readonly defaultTtlMs: number | null;

  private readonly lookup = new Map<K, CacheNode<K, V>>();
  private head: CacheNode<K, V> | null = null; // Most Recently Used (MRU)
  private tail: CacheNode<K, V> | null = null; // Least Recently Used (LRU)

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: LruCacheOptions) {
    if (options.capacity <= 0) {
      throw new RangeError("Cache capacity must be greater than 0");
    }
    this.capacity = options.capacity;
    this.defaultTtlMs = options.defaultTtlMs ?? null;
  }

  /**
   * Retrieves a value by key in O(1) time.
   * Promotes the accessed node to the Head (MRU).
   */
  public get(key: K): V | undefined {
    const node = this.lookup.get(key);

    if (!node) {
      this.misses++;
      return undefined;
    }

    const now = Date.now();
    if (node.isExpired(now)) {
      this.expirations++;
      this.misses++;
      this.removeNode(node);
      this.lookup.delete(key);
      return undefined;
    }

    this.hits++;
    this.moveToHead(node);
    return node.value;
  }

  /**
   * Inserts or updates a value in O(1) time.
   * If capacity is exceeded, evicts the Tail (LRU).
   */
  public set(key: K, value: V, ttlMs?: number): void {
    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAtMs = ttl !== null ? now + ttl : null;

    let node = this.lookup.get(key);

    if (node) {
      // Update existing node
      node.value = value;
      node.expiresAtMs = expiresAtMs;
      this.moveToHead(node);
      return;
    }

    // New node insertion
    node = new CacheNode(key, value, expiresAtMs);
    this.lookup.set(key, node);
    this.attachToHead(node);

    // Evict least recently used if over capacity
    if (this.lookup.size > this.capacity) {
      this.evictTail();
    }
  }

  /**
   * Deletes a key from the cache in O(1) time.
   */
  public delete(key: K): boolean {
    const node = this.lookup.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.lookup.delete(key);
    return true;
  }

  /**
   * Checks if a key exists and is unexpired in O(1) time without promoting its usage.
   */
  public has(key: K): boolean {
    const node = this.lookup.get(key);
    if (!node) return false;

    if (node.isExpired(Date.now())) {
      this.expirations++;
      this.removeNode(node);
      this.lookup.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Clears all items and resets statistics.
   */
  public clear(): void {
    this.lookup.clear();
    this.head = null;
    this.tail = null;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  public get size(): number {
    return this.lookup.size;
  }

  public getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRatio = totalRequests > 0 ? Number((this.hits / totalRequests).toFixed(4)) : 0;

    return {
      size: this.lookup.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      hitRatio,
    };
  }

  /**
   * Removes expired items across the cache (active cleanup sweep).
   */
  public purgeExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, node] of this.lookup.entries()) {
      if (node.isExpired(now)) {
        this.removeNode(node);
        this.lookup.delete(key);
        this.expirations++;
        purged++;
      }
    }

    return purged;
  }

  // --- Doubly Linked List Pointer Operations ---

  private attachToHead(node: CacheNode<K, V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: CacheNode<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: CacheNode<K, V>): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.attachToHead(node);
  }

  private evictTail(): void {
    if (!this.tail) return;

    const lruNode = this.tail;
    this.removeNode(lruNode);
    this.lookup.delete(lruNode.key);
    this.evictions++;
  }
}
