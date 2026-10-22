import { describe, expect, it } from 'vitest';

import { parseBasicChoice, scoresMatch, tallyBasic } from '../src/tally';

describe('parseBasicChoice', () => {
  it('accepts an option index', () => {
    expect(parseBasicChoice(3, 3)).toBe(3);
  });

  for (const choice of [0, 4, 1.5, '1', [1], { 1: 1 }, null]) {
    it(`rejects ${JSON.stringify(choice)}`, () => {
      expect(() => parseBasicChoice(choice, 3)).toThrow('not a valid option index');
    });
  }
});

describe('tallyBasic', () => {
  it('sums power per option', () => {
    const votes = [
      { choice: 1, score: 10 },
      { choice: 3, score: 5 },
      { choice: 1, score: 2.5 },
    ];

    expect(tallyBasic(votes, 3)).toEqual([12.5, 0, 5]);
  });
});

describe('scoresMatch', () => {
  it('tolerates float noise and nothing more', () => {
    expect(scoresMatch(1_000_000, 1_000_000 + 1e-7)).toBe(true);
    expect(scoresMatch(1_000_000, 1_000_000.01)).toBe(false);
    expect(scoresMatch(4.878e-15, 4.878_000_000_000_001e-15)).toBe(true);
    expect(scoresMatch(4.878e-15, 4.879e-15)).toBe(false);
    expect(scoresMatch(0, 0)).toBe(true);
    expect(scoresMatch(0, 1e-18)).toBe(false);
  });
});
