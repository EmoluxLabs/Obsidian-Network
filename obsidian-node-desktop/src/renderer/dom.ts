/**
 * Safe HTML building. Every interpolated value is escaped unless it was produced by `html`
 * itself (or explicitly wrapped with `raw`, which the code reserves for static markup such as
 * icons). Nothing received from the node, the wallet or the user can inject markup.
 */
class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Html = Safe;

export function raw(value: string): Html {
  return new Safe(value);
}

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function part(value: unknown): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  return esc(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += part(values[i]);
  });
  return new Safe(out);
}

export const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null => root.querySelector<T>(selector);
export const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll<T>(selector));

export function inputValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el ? el.value : '';
}

export function isChecked(id: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return Boolean(el?.checked);
}
