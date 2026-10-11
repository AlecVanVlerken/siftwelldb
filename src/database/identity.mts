/** User-controlled dictionary keys must never resolve through Object.prototype. */
export function safeDictionary<T>(source?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source);
}

export function indexCacheKey(collection: string, field: string): string {
  return JSON.stringify([collection, field]);
}

export type SemanticIndexKind = 'default' | 'text' | 'image';

export function semanticIndexKey(collection: string, kind: SemanticIndexKind): string {
  return JSON.stringify([collection, kind]);
}

export function semanticIndexIdentity(key: string): [string, SemanticIndexKind] {
  const identity: unknown = JSON.parse(key);
  if (
    !Array.isArray(identity) ||
    identity.length !== 2 ||
    typeof identity[0] !== 'string' ||
    !['default', 'text', 'image'].includes(identity[1] as string)
  ) {
    throw new Error('Invalid persisted semantic index identity.');
  }
  return identity as [string, SemanticIndexKind];
}
