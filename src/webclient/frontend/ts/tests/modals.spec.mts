import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('modal keyboard handling during blocking maintenance', () => {
  it('does not dismiss or focus an inert underlying dialog, and resumes normal Escape afterward', async () => {
    const listeners = new Map<string, EventListener>();
    const classes = new Set(['hidden']);
    class Modal {
      inert = false;
      tabIndex = 0;
      classList = {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      };
      focus = vi.fn();
      querySelectorAll = vi.fn(() => []);
      setAttribute = vi.fn();
      removeAttribute = vi.fn();
    }
    const modal = new Modal();
    vi.stubGlobal('HTMLElement', Modal);
    vi.stubGlobal('document', {
      activeElement: null,
      querySelector: () => modal,
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    });
    const { openModal } = await import('../modals.js');
    openModal('modal-settings');
    expect(classes.has('hidden')).toBe(false);
    modal.focus.mockClear();
    modal.inert = true;

    for (const key of ['Escape', 'Tab']) {
      const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      listeners.get('keydown')!(event as unknown as Event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(classes.has('hidden')).toBe(false);
      expect(modal.focus).not.toHaveBeenCalled();
    }

    modal.inert = false;
    const escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.get('keydown')!(escape as unknown as Event);
    expect(classes.has('hidden')).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
  });
});
