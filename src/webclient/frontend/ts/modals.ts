import { $ } from './dom.js';

type OpenModal = { id: string; element: HTMLElement; returnFocus: HTMLElement | null };

const openModals: OpenModal[] = [];
let keyboardHandlerInstalled = false;
const focusableSelector =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function focusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

function focusModal(modal: HTMLElement): void {
  const elements = focusableElements(modal);
  const input = elements.find((element) => element.matches('input, textarea, select, [contenteditable="true"]'));
  (input ?? elements[0] ?? modal).focus();
}

function handleModalKeyboard(event: KeyboardEvent): void {
  const current = openModals.at(-1);
  if (!current) return;
  if (event.key === 'Escape') {
    if (current.id !== 'modal-connect') closeModal(current.id);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key !== 'Tab') return;
  const elements = focusableElements(current.element);
  const first = elements[0];
  const last = elements.at(-1);
  const active = document.activeElement;
  if (!first || !last) {
    event.preventDefault();
    current.element.focus();
  } else if (!current.element.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function openModal(id: string): void {
  const modal = $<HTMLElement>(`#${id}`);
  if (!modal) throw new Error(`Missing modal: ${id}`);
  if (!keyboardHandlerInstalled) {
    document.addEventListener('keydown', handleModalKeyboard, true);
    keyboardHandlerInstalled = true;
  }
  if (!openModals.some((entry) => entry.id === id)) {
    openModals.push({
      id,
      element: modal,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }
  modal.classList.remove('hidden');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;
  focusModal(modal);
}

export function closeModal(id: string): void {
  const modal = $<HTMLElement>(`#${id}`);
  if (!modal) throw new Error(`Missing modal: ${id}`);
  modal.classList.add('hidden');
  modal.removeAttribute('aria-modal');
  const index = openModals.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const wasTop = index === openModals.length - 1;
  const [closed] = openModals.splice(index, 1);
  if (!wasTop) return;
  if (closed.returnFocus?.isConnected && closed.returnFocus.getClientRects().length > 0) closed.returnFocus.focus();
  else if (openModals.length > 0) focusModal(openModals[openModals.length - 1].element);
}
