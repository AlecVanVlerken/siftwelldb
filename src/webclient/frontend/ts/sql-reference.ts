import { $ } from './dom.js';
import { esc } from './format.js';
import { openModal } from './modals.js';

type ReferenceSection = { id: string; title: string; paragraphs: string[]; examples: string[] };
type Reference = { title: string; sections: ReferenceSection[] };
let loading: Promise<void> | undefined;

async function loadReference(): Promise<void> {
  const container = $<HTMLElement>('#sql-reference-content');
  if (!container) throw new Error('Missing SQL reference panel');
  const response = await fetch('/sql-reference.json');
  if (!response.ok) throw new Error('SQL reference could not be loaded. Rebuild the webclient assets and retry.');
  const reference = (await response.json()) as Reference;
  container.innerHTML = `<nav aria-label="SQL reference sections">${reference.sections.map((section) => `<a href="#sql-ref-${esc(section.id)}">${esc(section.title)}</a>`).join('')}</nav>${reference.sections.map((section) => `<section id="sql-ref-${esc(section.id)}" tabindex="-1"><h2>${esc(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}${section.examples.map((example) => `<pre><code>${esc(example)}</code></pre>`).join('')}</section>`).join('')}`;
  container.querySelectorAll<HTMLAnchorElement>('nav a').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const section = document.getElementById(link.hash.slice(1));
      section?.scrollIntoView({ block: 'start' });
      section?.focus({ preventScroll: true });
    });
  });
}

export function openSqlReference(): void {
  openModal('modal-sql-reference');
  loading ??= loadReference().catch((error: unknown) => {
    const container = $<HTMLElement>('#sql-reference-content');
    if (container) container.textContent = error instanceof Error ? error.message : String(error);
    loading = undefined;
  });
}
