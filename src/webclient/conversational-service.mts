import * as fs from 'node:fs/promises';
import type { SimpleDbms } from '../dbms/simpledbms.mjs';
import { ConversationalEngine } from '../conversational/conversationalEngine.mjs';
import { GeminiProvider } from '../conversational/llmProvider.mjs';
import type { ChatMessage } from '../conversational/llmProvider.mjs';
import {
  generateSemanticModel,
  enrichModelWithLLM,
  parseSemanticModel,
} from '../conversational/semanticModel.mjs';
import type { SemanticModel } from '../conversational/semanticModel.mjs';
import type { AnalyticsResponse } from '../conversational/conversationalEngine.mjs';

/**
 * Manages the conversational analytics engine for the main webclient.
 *
 * Lifecycle:
 *   - Call `onConnect(dbPath, dbms)` after a database is opened.
 *   - Call `onDisconnect()` when the database is closed / reset.
 *
 * The semantic model is persisted as `{dbPath}.model.json` alongside the DB file.
 * If `GEMINI_API_KEY` is not set, model generation and chat are unavailable, but
 * an existing model file can still be read and served.
 */
export class ConversationalService {
  private apiKey: string | null;
  private dbPath: string | null = null;
  private dbms: SimpleDbms | null = null;
  private model: SemanticModel | null = null;
  private engine: ConversationalEngine | null = null;

  constructor() {
    this.apiKey = process.env['GEMINI_API_KEY'] ?? null;
  }

  /** True when a Gemini API key is configured. */
  get llmAvailable(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Update the Gemini API key at runtime.
   * Rebuilds the engine immediately if a model is already loaded.
   */
  setApiKey(key: string): void {
    this.apiKey = key || null;
    process.env['GEMINI_API_KEY'] = key;
    this.rebuildEngine();
  }

  /** True when an engine is ready to answer questions. */
  get engineReady(): boolean {
    return this.engine !== null;
  }

  /** The current semantic model, or null if none has been loaded/generated. */
  getModel(): SemanticModel | null {
    return this.model;
  }

  /** Returns true when the given collection has an explore in the current model. */
  hasExploreForCollection(collection: string): boolean {
    return this.model?.explores.some((e) => e.collection === collection) ?? false;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /**
   * Called after a database is successfully opened.
   * Tries to load an existing `{dbPath}.model.json`; rebuilds the engine if found.
   */
  async onConnect(dbPath: string, dbms: SimpleDbms): Promise<void> {
    this.dbPath = dbPath;
    this.dbms = dbms;
    this.model = null;
    this.engine = null;

    try {
      const raw = await fs.readFile(this.modelFilePath(), 'utf-8');
      this.model = parseSemanticModel(raw);
      this.rebuildEngine();
    } catch {
      // No model file yet — that is normal for a fresh database.
    }
  }

  /** Called when the database is disconnected or reset. */
  onDisconnect(): void {
    this.dbPath = null;
    this.dbms = null;
    this.model = null;
    this.engine = null;
  }

  // ── Model management ─────────────────────────────────────────

  /**
   * Auto-generate a semantic model by introspecting the database.
   *
   * Two-stage process:
   *   1. Pure introspection — reads B+ tree metadata + a sample document
   *      for every collection. Always runs, never fails.
   *   2. LLM enrichment — asks Gemini to add descriptions, synonyms,
   *      hidden flags, and analytics measures. Optional. If no API key
   *      is configured, or if the LLM call fails, this step is skipped
   *      silently and the basic introspected model is what gets
   *      persisted.
   *
   * The result is always a valid model file the user can hand-edit.
   * `enriched` in the return tuple reports whether stage 2 actually ran
   * so the caller can show an appropriate toast.
   */
  async generateModel(): Promise<{ model: SemanticModel; enriched: boolean }> {
    this.ensureDbConnected();
    let model = await generateSemanticModel(this.dbms!);
    if (this.apiKey) {
      const llm = new GeminiProvider(this.apiKey);
      model = await enrichModelWithLLM(model, this.dbms!, llm);
    }
    // The basic introspection step never adds field descriptions; only
    // the LLM enrichment does. So "any field has a description" is a
    // reliable signal that Gemini actually contributed.
    const enriched = model.explores.some((e) =>
      !!e.description || e.fields.some((f) => !!f.description),
    );
    await this.persistModel(model);
    return { model, enriched };
  }

  /**
   * Save a model supplied as a JSON string (e.g. from a manual editor).
   * Validates, persists, and rebuilds the engine.
   */
  async saveModel(json: string): Promise<SemanticModel> {
    this.ensureDbConnected();
    const model = parseSemanticModel(json);
    await this.persistModel(model);
    return model;
  }

  // ── Querying ─────────────────────────────────────────────────

  /**
   * Ask a natural-language question about the data.
   * `history` is the caller's copy of the chat history; the engine updates it
   * in-place via the returned response — callers should track history client-side.
   */
  async ask(question: string, history: ChatMessage[]): Promise<AnalyticsResponse> {
    if (!this.engine) {
      throw new Error(
        this.model
          ? 'GEMINI_API_KEY is not set — cannot answer questions'
          : 'No semantic model found. Generate one first.',
      );
    }
    return this.engine.ask(question, history);
  }

  // ── Internal helpers ─────────────────────────────────────────

  private modelFilePath(): string {
    return `${this.dbPath}.model.json`;
  }

  private async persistModel(model: SemanticModel): Promise<void> {
    await fs.writeFile(this.modelFilePath(), JSON.stringify(model, null, 2), 'utf-8');
    this.model = model;
    this.rebuildEngine();
  }

  private rebuildEngine(): void {
    if (!this.apiKey || !this.model || !this.dbms) {
      this.engine = null;
      return;
    }
    const llm = new GeminiProvider(this.apiKey);
    this.engine = new ConversationalEngine({
      dbms: this.dbms,
      llmProvider: llm,
      semanticModel: this.model,
    });
  }

  private ensureDbConnected(): void {
    if (!this.dbms || !this.dbPath) throw new Error('No database connected');
  }
}
