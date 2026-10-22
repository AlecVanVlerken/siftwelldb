import type { DemoStatus } from './demo-session.js';

/** Dictionaries indexed by database names must never consult inherited properties. */
export function createDictionary<T>(values: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, values);
}

export type WebclientState = {
  connected: boolean;
  filepath: string | null;
  temporaryDemo: DemoStatus | null;
  demoCreation: DemoStatus | null;
  geminiKeySet: boolean;
  collections: string[];
  countsByColl: Record<string, number | '?'>;
  docsByColl: Record<string, Array<Record<string, unknown>>>;
  model: Record<string, unknown> | null;
  selectedCol: string | null;
  tab: string;
  chatHistory: Array<Record<string, unknown>>;
  sqlHistory: Array<Record<string, unknown>>;
  selectedDoc: Record<string, unknown> | null;
  selectedDocIndex: number | null;
  dataFilter: string;
  dataSort: { col: string; dir: 'asc' | 'desc' } | null;
  treeExpanded: Record<string, boolean>;
  modelPromptDismissed: Record<string, boolean>;
  modelGenerating: boolean;
  seedBusy: boolean;
  search: {
    mode: 'text' | 'image';
    query: string;
    image: { name: string; dataUrl: string; buffer: string } | null;
    busy: boolean;
    results: string[] | null;
    error: string | null;
    elapsedMs: number | null;
    embedStatus: { state: string; error: string | null };
  };
  databaseStatus: Record<string, unknown> | null;
  compression: {
    workload: number;
    recommendations: Record<string, Record<string, unknown>>;
    defaults: Record<string, string>;
  };
  lab: {
    collection: string;
    workload: number;
    report: Record<string, unknown> | null;
    busy: boolean;
    error: string | null;
  };
};

export const state: WebclientState = {
  connected: false,
  filepath: null,
  temporaryDemo: null,
  demoCreation: null,
  geminiKeySet: false,
  collections: [],
  countsByColl: createDictionary(),
  docsByColl: createDictionary(),
  model: null,
  selectedCol: null,
  tab: 'overview',
  chatHistory: [],
  sqlHistory: [],
  selectedDoc: null,
  selectedDocIndex: null,
  dataFilter: '',
  dataSort: null,
  treeExpanded: createDictionary(),
  modelPromptDismissed: createDictionary(),
  modelGenerating: false,
  seedBusy: false,
  search: {
    mode: 'text',
    query: '',
    image: null,
    busy: false,
    results: null,
    error: null,
    elapsedMs: null,
    embedStatus: { state: 'idle', error: null },
  },
  databaseStatus: null,
  compression: {
    workload: 0.5,
    recommendations: createDictionary(),
    defaults: createDictionary(),
  },
  lab: {
    collection: 'wiki_lab',
    workload: 0,
    report: null,
    busy: false,
    error: null,
  },
};

export type RequestContext = {
  readonly scope: 'database' | 'collection';
  readonly databaseEpoch: number;
  readonly collectionEpoch: number;
  readonly connected: boolean;
  readonly filepath: string | null;
  readonly collection: string | null;
};

let databaseContextEpoch = 0;
let collectionContextEpoch = 0;

/** Invalidates pending UI responses before changing database or collection context. */
export function invalidateRequestContext(scope: 'database' | 'collection' = 'collection'): void {
  if (scope === 'database') databaseContextEpoch++;
  collectionContextEpoch++;
}

export function captureRequestContext(scope: 'database' | 'collection' = 'collection'): RequestContext {
  return {
    scope,
    databaseEpoch: databaseContextEpoch,
    collectionEpoch: collectionContextEpoch,
    connected: state.connected,
    filepath: state.filepath,
    collection: state.selectedCol,
  };
}

export function isCurrentRequestContext(context: RequestContext): boolean {
  return (
    context.databaseEpoch === databaseContextEpoch &&
    context.connected === state.connected &&
    context.filepath === state.filepath &&
    (context.scope === 'database' ||
      (context.collectionEpoch === collectionContextEpoch && context.collection === state.selectedCol))
  );
}

export function resetDisconnectedState(): void {
  invalidateRequestContext('database');
  state.connected = false;
  state.filepath = null;
  state.temporaryDemo = null;
  state.demoCreation = null;
  state.collections = [];
  state.docsByColl = createDictionary();
  state.countsByColl = createDictionary();
  state.model = null;
  state.selectedCol = null;
  state.tab = 'overview';
  state.chatHistory = [];
  state.sqlHistory = [];
  state.selectedDoc = null;
  state.selectedDocIndex = null;
  state.dataFilter = '';
  state.dataSort = null;
  state.treeExpanded = createDictionary();
  state.modelPromptDismissed = createDictionary();
  state.modelGenerating = false;
  state.seedBusy = false;
  state.search = {
    mode: 'text',
    query: '',
    image: null,
    busy: false,
    results: null,
    error: null,
    elapsedMs: null,
    embedStatus: state.search.embedStatus,
  };
  state.databaseStatus = null;
  state.compression.recommendations = createDictionary();
  state.compression.defaults = createDictionary();
  state.lab.report = null;
  state.lab.error = null;
  state.lab.collection = 'wiki_lab';
  state.lab.busy = false;
}
