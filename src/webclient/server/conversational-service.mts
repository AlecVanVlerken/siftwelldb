import * as fs from 'node:fs/promises';
import type { SimpleDbms } from '../../database/simpledbms.mjs';
import { ConversationalEngine } from '../../conversational/conversationalEngine.mjs';
import { GeminiProvider } from '../../conversational/llmProvider.mjs';
import type { ChatMessage } from '../../conversational/llmProvider.mjs';
import { generateSemanticModel, enrichModelWithLLM, parseSemanticModel } from '../../conversational/semanticModel.mjs';
import type { SemanticModel } from '../../conversational/semanticModel.mjs';
import type { AnalyticsResponse } from '../../conversational/conversationalEngine.mjs';

type DatabaseSession = { version: number; dbPath: string; dbms: SimpleDbms };

/**
 * Manages the conversational analytics engine for the main webclient.
 *
 * Lifecycle:
 *   - Call `onConnect(dbPath, dbms)` after a database is opened.
 *   - Call `onDisconnect()` when the database is closed / reset.
 *
 * The semantic model is persisted as `{dbPath}.model.json` alongside the DB file.
 * Model generation and editing work without `GEMINI_API_KEY`. The key is
 * required only for optional model enrichment and conversational answers.
 */
export class ConversationalService {
  private apiKey: string | null;
  private dbPath: string | null = null;
  private dbms: SimpleDbms | null = null;
  private model: SemanticModel | null = null;
  private engine: ConversationalEngine | null = null;
  private sessionVersion = 0;

  constructor() {
    const raw = process.env['GEMINI_API_KEY'];
    this.apiKey = raw && raw.trim() ? raw.trim() : null;
  }

  /** True when a Gemini API key is configured. Empty / whitespace-only strings count as "no key". */
  get llmAvailable(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /**
   * Update the Gemini API key at runtime.
   * Rebuilds the engine immediately if a model is already loaded.
   */
  setApiKey(key: string): void {
    const trimmed = key.trim();
    this.apiKey = trimmed.length > 0 ? trimmed : null;
    process.env['GEMINI_API_KEY'] = trimmed;
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
    const version = ++this.sessionVersion;
    this.dbPath = dbPath;
    this.dbms = dbms;
    this.model = null;
    this.engine = null;

    try {
      const raw = await fs.readFile(`${dbPath}.model.json`, 'utf-8');
      const model = parseSemanticModel(raw);
      if (version !== this.sessionVersion) return;
      this.model = model;
      this.rebuildEngine();
    } catch {
      // No model file yet — that is normal for a fresh database.
    }
  }

  /** Called when the database is disconnected or reset. */
  onDisconnect(): void {
    this.sessionVersion++;
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
   *      for every collection. Does not require an API key.
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
    const session = this.getSession();
    let model = await generateSemanticModel(session.dbms);
    this.ensureSession(session);
    if (model.explores.length === 0) {
      throw new Error('Add a collection before generating a schema model.');
    }
    if (this.apiKey) {
      const llm = new GeminiProvider(this.apiKey);
      model = await enrichModelWithLLM(model, session.dbms, llm);
    }
    // The basic introspection step never adds field descriptions; only
    // the LLM enrichment does. So "any field has a description" is a
    // reliable signal that Gemini actually contributed.
    const enriched = model.explores.some((e) => !!e.description || e.fields.some((f) => !!f.description));
    await this.persistModel(model, session);
    return { model, enriched };
  }

  /**
   * Save a model supplied as a JSON string (e.g. from a manual editor).
   * Validates, persists, and rebuilds the engine.
   */
  async saveModel(json: string): Promise<SemanticModel> {
    const session = this.getSession();
    const model = parseSemanticModel(json);
    await this.persistModel(model, session);
    return model;
  }

  /** Remove a dropped collection from the saved schema without altering other explores. */
  async removeCollection(collection: string): Promise<void> {
    const session = this.getSession();
    if (!this.model?.explores.some((explore) => explore.collection === collection)) return;
    const remaining = this.model.explores.filter((explore) => explore.collection !== collection);
    if (remaining.length > 0) {
      await this.persistModel({ explores: remaining }, session);
      return;
    }
    await fs.unlink(`${session.dbPath}.model.json`).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
    this.ensureSession(session);
    this.model = null;
    this.rebuildEngine();
  }

  // ── Querying ─────────────────────────────────────────────────

  /**
   * Ask a natural-language question about the data.
   * `history` is the caller's copy of the chat history; the engine updates it
   * in-place via the returned response — callers should track history client-side.
   */
  async ask(question: string, history: ChatMessage[], collection?: string): Promise<AnalyticsResponse> {
    if (!this.engine) {
      throw new Error(
        this.model
          ? 'GEMINI_API_KEY is not set — cannot answer questions'
          : 'No semantic model found. Generate one first.',
      );
    }
    if (collection && this.model) {
      const explore = this.model.explores.find((e) => e.collection === collection);
      if (!explore) {
        throw new Error(`No semantic model found for collection "${collection}". Generate one first.`);
      }
      if (!this.apiKey || !this.dbms) {
        throw new Error('GEMINI_API_KEY is not set — cannot answer questions');
      }
      const scopedEngine = new ConversationalEngine({
        dbms: this.dbms,
        llmProvider: new GeminiProvider(this.apiKey),
        semanticModel: { explores: [explore] },
      });
      return scopedEngine.ask(question, history);
    }
    return this.engine.ask(question, history);
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async persistModel(model: SemanticModel, session: DatabaseSession): Promise<void> {
    this.ensureSession(session);
    const validated = parseSemanticModel(JSON.stringify(model));
    const collections = new Set(session.dbms.listCollections());
    for (const explore of validated.explores) {
      if (!collections.has(explore.collection)) {
        throw new Error(`Collection "${explore.collection}" does not exist in the connected database.`);
      }
    }
    await fs.writeFile(`${session.dbPath}.model.json`, JSON.stringify(validated, null, 2), 'utf-8');
    this.ensureSession(session);
    this.model = validated;
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

  private getSession(): DatabaseSession {
    if (!this.dbms || !this.dbPath) throw new Error('No database connected');
    return { version: this.sessionVersion, dbPath: this.dbPath, dbms: this.dbms };
  }

  private ensureSession(session: DatabaseSession): void {
    if (session.version !== this.sessionVersion) {
      throw new Error('The database connection changed. Try again on the current database.');
    }
  }
}
