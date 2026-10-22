import { describe, expect, it, vi } from 'vitest';
import { DemoCreation, demoProgress, type DemoStatus } from '../demo-session.js';

function status(overrides: Partial<DemoStatus> = {}): DemoStatus {
  return {
    id: 'demo-1',
    state: 'creating',
    stage: 'Importing photographs',
    collection: 'photos',
    completed: 12,
    total: 100,
    counts: { employees: 200, photos: 12 },
    error: null,
    filepath: null,
    temporary: true,
    bytes: null,
    warnings: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('temporary demo creation client', () => {
  it('creates without a file path and reports server progress until the completed demo opens', async () => {
    const creating = status();
    const ready = status({ state: 'ready', completed: 100, filepath: 'owned-temp/demo.db' });
    const request = vi.fn().mockResolvedValueOnce({ demo: creating }).mockResolvedValueOnce({ demo: ready });
    const progress = vi.fn<(value: DemoStatus) => void>();
    const flow = new DemoCreation('tab-1', progress, request, () => Promise.resolve());

    expect(await flow.start()).toEqual(ready);
    expect(request.mock.calls).toEqual([
      ['/api/demo/create', { method: 'POST', body: { clientId: 'tab-1' } }],
      ['/api/demo/status?clientId=tab-1'],
    ]);
    expect(progress.mock.calls.map(([value]) => value.state)).toEqual(['creating', 'ready']);
  });

  it('prevents duplicate creation requests while the first request is pending', async () => {
    const pending = deferred<{ demo: DemoStatus }>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const flow = new DemoCreation('tab-1', vi.fn(), request);
    const first = flow.start();
    expect(await flow.start()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve({ demo: status({ state: 'ready' }) });
    expect(await first).toMatchObject({ state: 'ready' });
  });

  it('cancels the owned server task even when cancellation precedes the creation acknowledgement', async () => {
    const pending = deferred<{ demo: DemoStatus }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ demo: status({ state: 'idle' }) });
    const progress = vi.fn();
    const flow = new DemoCreation('tab-1', progress, request);
    const result = flow.start();
    await flow.cancel();
    pending.resolve({ demo: status() });

    expect(await result).toBeNull();
    expect(request).toHaveBeenLastCalledWith('/api/demo/cancel', {
      method: 'POST',
      body: { clientId: 'tab-1', demoId: 'demo-1' },
    });
    expect(progress).not.toHaveBeenCalled();
  });

  it('ignores a delayed ready response after cancellation instead of publishing an abandoned demo', async () => {
    const poll = deferred<{ demo: DemoStatus }>();
    const enteredPoll = deferred<void>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ demo: status() })
      .mockImplementationOnce(() => {
        enteredPoll.resolve();
        return poll.promise;
      })
      .mockResolvedValueOnce({ demo: status({ state: 'cancelling' }) });
    const progress = vi.fn();
    const flow = new DemoCreation('tab-1', progress, request, () => Promise.resolve());
    const result = flow.start();
    await enteredPoll.promise;
    await flow.cancel();
    poll.resolve({ demo: status({ state: 'ready' }) });

    expect(await result).toBeNull();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'creating' }));
  });

  it('keeps following an acknowledged creation when an earlier cancellation is refused', async () => {
    const pending = deferred<{ demo: DemoStatus }>();
    const refusal = new Error('Another tab is using the demo.');
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({ demo: status({ state: 'ready' }) });
    const refused = vi.fn();
    const flow = new DemoCreation('tab-1', vi.fn(), request, () => Promise.resolve(), refused);
    const result = flow.start();
    await flow.cancel();
    pending.resolve({ demo: status() });

    expect(await result).toMatchObject({ state: 'ready' });
    expect(refused).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('resumes an existing creation after reload without creating another database', async () => {
    const request = vi.fn().mockResolvedValue({ demo: status({ state: 'ready' }) });
    const flow = new DemoCreation('reloaded-tab', vi.fn(), request, () => Promise.resolve());

    expect(await flow.start(status())).toMatchObject({ state: 'ready' });
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/demo/status?clientId=reloaded-tab');
  });

  it('keeps following creation if cancellation is rejected because another tab is using it', async () => {
    const wait = deferred<void>();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Another tab is using the demo.'))
      .mockResolvedValueOnce({ demo: status({ state: 'ready' }) });
    const flow = new DemoCreation('tab-1', vi.fn(), request, () => wait.promise);
    const result = flow.start(status());

    await expect(flow.cancel()).rejects.toThrow('Another tab is using the demo.');
    wait.resolve();
    expect(await result).toMatchObject({ state: 'ready' });
  });

  it('reports a failed server build and allows a subsequent creation attempt', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ demo: status({ state: 'failed', error: 'Image model unavailable.' }) })
      .mockResolvedValueOnce({ demo: status({ state: 'ready' }) });
    const flow = new DemoCreation('tab-1', vi.fn(), request);

    await expect(flow.start()).rejects.toThrow('Image model unavailable.');
    expect(await flow.start()).toMatchObject({ state: 'ready' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses to open a different demo that replaces the creation it was following', async () => {
    const request = vi.fn().mockResolvedValue({ demo: status({ id: 'other-demo', state: 'ready' }) });
    const flow = new DemoCreation('tab-1', vi.fn(), request, () => Promise.resolve());
    await expect(flow.start(status())).rejects.toThrow('The demo session changed.');
  });

  it('keeps progress bounded and shows the active collection with document counts', () => {
    expect(demoProgress(status())).toEqual({ percent: 12, detail: '12 of 100 documents · photos' });
    expect(demoProgress(status({ completed: 101 }))).toMatchObject({ percent: 100 });
    expect(demoProgress(status({ total: 0 }))).toEqual({
      percent: 0,
      detail: 'Preparing documents and semantic models…',
    });
  });
});
