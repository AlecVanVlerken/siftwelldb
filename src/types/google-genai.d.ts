declare module '@google/genai' {
  export type ContentPart = {
    text?: string;
  };

  export type Content = {
    role?: string;
    parts?: ContentPart[];
  };

  export type GenerateContentRequest = {
    model: string;
    config?: {
      systemInstruction?: string;
    };
    contents: string | Content[];
  };

  export type GenerateContentResponse = {
    text?: string | null;
  };

  export class GoogleGenAI {
    constructor(options: { apiKey: string });

    readonly models: {
      generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse>;
    };
  }
}
