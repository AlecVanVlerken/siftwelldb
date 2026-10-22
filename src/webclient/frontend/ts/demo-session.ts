import { api } from './api-client.js';

export type DemoStatus = {
  id: string | null;
  state: 'idle' | 'creating' | 'ready' | 'failed' | 'cancelling';
  stage: string;
  collection: string | null;
  completed: number;
  total: number;
  counts: Record<string, number>;
  error: string | null;
  filepath: string | null;
  temporary: boolean;
  bytes: number | null;
  warnings: string[];
  clientActive?: boolean;
};

type DemoRequest = (
  path: string,
  options?: { method?: string; body?: Record<string, unknown> },
) => Promise<{ demo: DemoStatus }>;

/** One creation at a time; cancellation also wins over a delayed ready response. */
export class DemoCreation {
  private running = false;
  private cancelled = false;
  private cancellation: Promise<void> | null = null;
  private demoId: string | null = null;

  constructor(
    readonly clientId: string,
    private readonly onProgress: (status: DemoStatus) => void,
    private readonly request: DemoRequest = (path, options) => api(path, options),
    private readonly wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1000)),
    private readonly onCancellationRefused: (error: unknown) => void = () => undefined,
  ) {}

  async start(existing?: DemoStatus): Promise<DemoStatus | null> {
    if (this.running) return null;
    this.running = true;
    this.cancelled = false;
    this.demoId = existing?.id ?? null;
    try {
      let status =
        existing ??
        (await this.request('/api/demo/create', { method: 'POST', body: { clientId: this.clientId } })).demo;
      this.demoId = status.id;
      if (this.cancelled) {
        // The user can cancel before the initial creation request returns its ID.
        try {
          await this.cancel();
          return null;
        } catch (error) {
          this.onCancellationRefused(error);
        }
      }
      while (true) {
        this.onProgress(status);
        if (status.state === 'ready') return status;
        if (status.state === 'failed') throw new Error(status.error || 'Demo creation failed.');
        if (status.state === 'idle') return null;
        await this.wait();
        if (await this.isCancelled()) return null;
        const result = await this.request(`/api/demo/status?${new URLSearchParams({ clientId: this.clientId })}`);
        if (await this.isCancelled()) return null;
        status = result.demo;
        if (status.id !== null && status.id !== this.demoId) throw new Error('The demo session changed.');
      }
    } finally {
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.demoId) {
      this.cancellation = this.sendCancel().catch((error: unknown) => {
        this.cancelled = false;
        throw error;
      });
      try {
        await this.cancellation;
      } finally {
        this.cancellation = null;
      }
    }
  }

  private async isCancelled(): Promise<boolean> {
    // A server refusal (for example another active tab) keeps the original job alive.
    await this.cancellation?.catch(() => undefined);
    return this.cancelled;
  }

  private async sendCancel(): Promise<void> {
    await this.request('/api/demo/cancel', {
      method: 'POST',
      body: { clientId: this.clientId, demoId: this.demoId },
    });
  }
}

export function demoProgress(status: DemoStatus): { percent: number; detail: string } {
  const completed = Math.max(0, status.completed);
  const total = Math.max(0, status.total);
  return {
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    detail:
      total > 0
        ? `${completed.toLocaleString()} of ${total.toLocaleString()} documents${status.collection ? ` · ${status.collection}` : ''}`
        : 'Preparing documents and semantic models…',
  };
}
