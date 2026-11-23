import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_LABELS } from './messages';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.tsx') && !path.includes('.test.')) out.push(path);
  }
  return out;
}

/** "Iznos (RSD)" and "Iznos" are the same field: the refusal names it without the unit or the note. */
const bare = (label: string) => label.replace(/ \([^)]*\)$/, '');

/** Every label a form of the reception shows: label="…" props, <label> texts and <legend>s. */
function formLabels(): Set<string> {
  const labels = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\blabel="([^"]+)"/g)) labels.add(bare(m[1]));
    for (const m of text.matchAll(/<label[^>]*>\s*([^<{]+?)\s*<(?:input|select|textarea)/g)) labels.add(bare(m[1]));
    for (const m of text.matchAll(/<input[\s\S]*?\/>\s*([^<{]+?)\s*<\/label>/g)) labels.add(bare(m[1]));
    for (const m of text.matchAll(/<legend>([^<]+)<\/legend>/g)) labels.add(bare(m[1]));
    for (const m of text.matchAll(/<span className="field-label"[^>]*>\s*([^<]+?)\s*<\/span>/g)) labels.add(bare(m[1]));
  }
  return labels;
}

/** Fields the API can name that no form labels one-to-one; each has its reason. */
const NOT_A_FORM_LABEL: Record<string, string> = {
  to: 'the calendar has "Od" only; blocks ask for "Poslednja noć", prices for "Poslednji dan"',
  closed: 'a button on the price screen, not a field',
  registryId: 'the label follows the legal form: "Matični broj", "JMBG" or both while it is not chosen',
  source: 'set by the screen, never typed',
  channel: 'set by the screen, never typed',
  stays: 'the list of stays, not one field',
  version: 'sent by the screen from what it read',
  guestId: 'chosen from a list',
  key: 'made by the screen',
  day: 'the open day, never typed',
  'holder.language': 'chosen from a list on the new reservation',
};

describe('FIELD_LABELS', () => {
  it('every label a refusal can name is the label the form shows', () => {
    const shown = formLabels();
    const wrong = Object.entries(FIELD_LABELS)
      .filter(([field, label]) => !(field in NOT_A_FORM_LABEL) && !shown.has(label))
      .map(([field, label]) => `${field}: "${label}"`);
    expect(wrong).toEqual([]);
  });

  it('the exceptions are still needed: no form shows their label exactly', () => {
    const shown = formLabels();
    const stale = Object.keys(NOT_A_FORM_LABEL).filter((field) => field in FIELD_LABELS && shown.has(FIELD_LABELS[field]));
    expect(stale).toEqual([]);
  });

  it('the label walk sees the labels it is meant to (it would otherwise pass on an empty set)', () => {
    const shown = formLabels();
    for (const label of ['Pun naziv', 'Kategorija smeštaja', 'Obveznik PDV-a', 'Naziv objekta', 'Opis']) {
      expect(shown.has(label), label).toBe(true);
    }
  });
});

describe('messages.ts', () => {
  const text = readFileSync(join(SRC, 'lib/messages.ts'), 'utf8');
  const split = text.indexOf('const FIELD_LABELS');
  const objects = { MESSAGES: text.slice(0, split), FIELD_LABELS: text.slice(split) };

  it.each(Object.entries(objects))('%s has no key twice', (_name, body) => {
    const keys = [...body.matchAll(/^ {2}(?:'([\w.]+)'|([A-Za-z_]\w*)):/gm)].map((m) => m[1] ?? m[2]);
    expect(keys.length).toBeGreaterThan(20);
    const seen = new Set<string>();
    const twice = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(twice).toEqual([]);
  });
});
