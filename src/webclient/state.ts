// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

/**
 * Represents a document in the SimpleDBMS.
 *
 * @author Alexandre-Gatien Bienfet
 */
export interface Document {
  [key: string]: unknown;
}

// SortableJS is loaded via CDN in index.html
export interface SortableInstance {
  destroy(): void;
}

export interface SortableOptions {
  animation?: number;
  handle?: string;
  ghostClass?: string;
  chosenClass?: string;
}

declare global {
  var Sortable: {
    new (el: HTMLElement, options: SortableOptions): SortableInstance;
  };
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
  sortableInstance: null as SortableInstance | null,
  currentSearchMode: 'text' as 'text' | 'image',
};
