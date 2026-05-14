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
  treeExpanded: Record<string, boolean>;
  modelPromptDismissed: Record<string, boolean>;
  modelGenerating: boolean;
  search: {
    query: string;
    image: { name: string; dataUrl: string; buffer: string } | null;
    busy: boolean;
    results: string[] | null;
    error: string | null;
    elapsedMs: number | null;
    embedStatus: { state: string; error: string | null };
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
  treeExpanded: {},
  modelPromptDismissed: {},
  modelGenerating: false,
  search: {
    query: '',
    image: null,
    busy: false,
    results: null,
    error: null,
    elapsedMs: null,
    embedStatus: { state: 'idle', error: null },
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
}
