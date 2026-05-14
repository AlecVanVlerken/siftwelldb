export type WebclientState = {
  connected: boolean;
  filepath: string | null;
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
  geminiKeySet: false,
  collections: [],
  countsByColl: {},
  docsByColl: {},
  model: null,
  selectedCol: null,
  tab: 'overview',
  chatHistory: [],
  sqlHistory: [],
  selectedDoc: null,
  selectedDocIndex: null,
  dataFilter: '',
  dataSort: null,
  treeExpanded: {},
  modelPromptDismissed: {},
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
    recommendations: {},
    defaults: {},
  },
  lab: {
    collection: 'wiki_lab',
    workload: 0,
    report: null,
    busy: false,
    error: null,
  },
};

export function resetDisconnectedState(): void {
  state.connected = false;
  state.filepath = null;
  state.collections = [];
  state.docsByColl = {};
  state.countsByColl = {};
  state.model = null;
  state.selectedCol = null;
  state.chatHistory = [];
  state.databaseStatus = null;
  state.compression.recommendations = {};
  state.compression.defaults = {};
  state.lab.report = null;
  state.lab.error = null;
  state.lab.collection = 'wiki_lab';
}
