import { $ } from './dom.js';

export function openModal(id: string): void {
  const modal = $(`#${id}`);
  if (!modal) throw new Error(`Missing modal: ${id}`);
  modal.classList.remove('hidden');
}

export function closeModal(id: string): void {
  const modal = $(`#${id}`);
  if (!modal) throw new Error(`Missing modal: ${id}`);
  modal.classList.add('hidden');
}
