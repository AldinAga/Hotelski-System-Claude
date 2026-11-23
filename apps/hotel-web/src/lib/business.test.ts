import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from './types';
import { PAYMENT_METHOD_LABELS, dayMonth, daysLabel, formatPercent, formatTime, guestsGenitive, guestsLabel, missingLabel, parsePercent } from './business';

describe('parsePercent', () => {
  it.each([
    ['0', 0],
    ['10', 1000],
    ['10,5', 1050],
    ['10.5', 1050],
    ['20.25', 2025],
    ['0,07', 7],
    ['100', 10_000],
    ['  8 ', 800],
    // Float arithmetic would give 28.999… for 0.29 * 100.
    ['0,29', 29],
    ['1,1', 110],
  ])('%s is %i basis points', (text, bp) => {
    expect(parsePercent(text)).toBe(bp);
  });

  it.each(['', 'abc', '-5', '101', '100,01', '10,555', '1 000', '10%', ',5', '10,'])('%j is not a percentage', (text) => {
    expect(parsePercent(text)).toBeNull();
  });
});

describe('formatPercent', () => {
  it.each([
    [0, '0'],
    [1000, '10'],
    [1050, '10,5'],
    [1025, '10,25'],
    [7, '0,07'],
    [10_000, '100'],
  ])('%i is %s', (bp, text) => {
    expect(formatPercent(bp)).toBe(text);
  });

  it('what it shows parses back to the same basis points', () => {
    for (const bp of [0, 1, 7, 10, 50, 99, 100, 1000, 1050, 2025, 9999, 10_000]) {
      expect(parsePercent(formatPercent(bp))).toBe(bp);
    }
  });
});

describe('wording', () => {
  it('daysLabel: 1 dan, 2 dana, 11 dana, 21 dan', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 111].map(daysLabel)).toEqual(['1 dan', '2 dana', '5 dana', '11 dana', '12 dana', '21 dan', '22 dana', '111 dana']);
  });

  it('guestsLabel: 1 gost, 2 gosta, 5 gostiju, 11 gostiju, 22 gosta', () => {
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 111].map(guestsLabel)).toEqual([
      '0 gostiju',
      '1 gost',
      '2 gosta',
      '4 gosta',
      '5 gostiju',
      '11 gostiju',
      '12 gostiju',
      '14 gostiju',
      '21 gost',
      '22 gosta',
      '111 gostiju',
    ]);
  });

  it('dayMonth: D.M. with a trailing dot', () => {
    expect(dayMonth('2026-11-03')).toBe('3.11.');
    expect(dayMonth('2026-12-24')).toBe('24.12.');
  });

  it('formatTime reads the property zone: 22:30 UTC in November is 23:30, in July 00:30', () => {
    expect(formatTime('2026-11-02T22:30:00.000Z')).toBe('23:30');
    expect(formatTime('2026-07-02T22:30:00.000Z')).toBe('00:30');
    expect(formatTime('x')).toBe('x');
  });

  it('missingLabel names the registry id by the kind and passes an unknown field through', () => {
    expect(missingLabel('registryId', 'natural_person')).toBe('JMBG');
    expect(missingLabel('registryId', 'legal_entity')).toBe('matični broj');
    expect(missingLabel('registryId', null)).toBe('matični broj');
    expect(missingLabel('taxId', null)).toBe('PIB');
    expect(missingLabel('legalName', null)).toBe('pun naziv');
    expect(missingLabel('address', null)).toBe('adresa');
    expect(missingLabel('city', null)).toBe('mesto');
    expect(missingLabel('somethingNew', null)).toBe('somethingNew');
  });
});

describe('guestsGenitive (after "za")', () => {
  it.each([
    [1, '1 gosta'],
    [2, '2 gosta'],
    [4, '4 gosta'],
    [5, '5 gostiju'],
    [10, '10 gostiju'],
    [11, '11 gostiju'],
    [12, '12 gostiju'],
    [14, '14 gostiju'],
    [21, '21 gosta'],
    [22, '22 gosta'],
    [25, '25 gostiju'],
    [101, '101 gosta'],
    [111, '111 gostiju'],
  ])('%i → %s', (n, text) => {
    expect(guestsGenitive(n)).toBe(text);
  });
});

describe('payment method names', () => {
  it('the payment dialog and the day report call every method the same', () => {
    for (const m of PAYMENT_METHODS) expect(PAYMENT_METHOD_LABELS[m.value], m.value).toBe(m.label);
  });

  it('a bank transfer is "Virman" everywhere', () => {
    expect(PAYMENT_METHODS.find((m) => m.value === 'transfer')?.label).toBe('Virman');
    expect(PAYMENT_METHOD_LABELS.transfer).toBe('Virman');
  });
});
