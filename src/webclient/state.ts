// author: Alexandre-Gatien Bienfet
// date: 2026-02-23
//
// Global state and shared types for the SimpleDBMS webclient

export interface Document {
  [key: string]: unknown;
}

// SortableJS is loaded via CDN in index.html
declare global {
  // eslint-disable-next-line no-var
  var Sortable: any;
}

/**
 * Centralised, mutable application state.
 * Every module imports this same object so mutations are shared.
 */
export const state = {
  currentCollection: null as string | null,
  collections: [] as string[],
  allDocuments: [] as Document[],
  currentViewDoc: null as Document | null,
  isEditMode: false,
  isNewDocument: false,
  sortableInstance: null as any,
  currentSearchMode: 'text' as 'text' | 'image',
};
