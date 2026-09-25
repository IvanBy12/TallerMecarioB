/**
 * Colecciones inmutables en runtime.
 *
 * `ReadonlySet` / `ReadonlyMap` de TypeScript solo protegen en compilación:
 * un `Set` real tipado como `ReadonlySet` sigue exponiendo `add`/`delete`/
 * `clear` en runtime. Estas clases envuelven una copia privada (`#items`) y
 * no tienen métodos de mutación, así que `set.add(...)` falla con TypeError y
 * `Set.prototype.add.call(set, ...)` también (no es un `Set` real). La copia
 * se hace en el constructor: mutar el iterable de origen después no afecta a
 * la colección.
 */

export class FrozenSet<T> implements ReadonlySet<T> {
  readonly #items: Set<T>;

  constructor(items: Iterable<T> = []) {
    this.#items = new Set(items);
    Object.freeze(this);
  }

  get size(): number {
    return this.#items.size;
  }

  has(value: T): boolean {
    return this.#items.has(value);
  }

  forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#items) callback.call(thisArg, value, value, this);
  }

  entries(): SetIterator<[T, T]> {
    return this.#items.entries();
  }

  keys(): SetIterator<T> {
    return this.#items.keys();
  }

  values(): SetIterator<T> {
    return this.#items.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#items.values();
  }
}

export class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]> = []) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#entries) callback.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
}

// Impide que alguien reinstale métodos de mutación sobre los prototipos.
Object.freeze(FrozenSet.prototype);
Object.freeze(FrozenMap.prototype);
