import { describe, expect, it } from 'vitest';
import { nightsLabel } from './format';

describe('nightsLabel', () => {
  it('uses "noć" for 1, 21, 101 and "noći" for the rest, 11 included', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 101, 111].map(nightsLabel)).toEqual([
      '1 noć',
      '2 noći',
      '5 noći',
      '11 noći',
      '12 noći',
      '21 noć',
      '22 noći',
      '101 noć',
      '111 noći',
    ]);
  });
});
