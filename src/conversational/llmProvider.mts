// author: Conversational Analytics Module

import { GoogleGenAI, type Content } from '@google/genai';

export type LLMResponse = {
  text: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

/**
 * Abstract interface so the engine isn't coupled to a single LLM vendor.
 */
export interface LLMProvider {
  /** Single-turn generation (for one-off tasks like query generation). */
  generate(systemPrompt: string, userMessage: string): Promise<LLMResponse>;

  /** Multi-turn generation with conversation history. */
  chat(systemPrompt: string, history: ChatMessage[], userMessage: string): Promise<LLMResponse>;
}

export class GeminiProvider implements LLMProvider {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = 'gemini-2.5-flash') {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generate(systemPrompt: string, userMessage: string): Promise<LLMResponse> {
    const response = await this.client.models.generateContent({
      model: this.model,
      config: { systemInstruction: systemPrompt },
      contents: userMessage,
    });
    return { text: response.text ?? '' };
  }

  async chat(systemPrompt: string, history: ChatMessage[], userMessage: string): Promise<LLMResponse> {
    const contents: Content[] = history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    contents.push({ role: 'user', parts: [{ text: userMessage }] });

    const response = await this.client.models.generateContent({
      model: this.model,
      config: { systemInstruction: systemPrompt },
      contents,
    });
    return { text: response.text ?? '' };
  }
}
