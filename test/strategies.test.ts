import { describe, expect, it } from 'vitest';

import { mathParamsSchema } from '../src/schemas';
import { applyMathOperation } from '../src/strategies';

describe('applyMathOperation', () => {
  it('scales pool shares to tokens the way the settings file nests multiply under divide', () => {
    const shares = [2, 0, 6];
    const totalStake = [300, 300, 300];
    const totalShares = [200, 200, 200];
    const product = applyMathOperation('multiply', [shares, totalStake]);

    expect(applyMathOperation('divide', [product, totalShares])).toEqual([3, 0, 9]);
  });

  it('refuses to divide by zero like Snapshot does', () => {
    expect(() => applyMathOperation('divide', [[1], [0]])).toThrow('Cannot divide by zero!');
  });

  it('clamps minus at zero and applies the comparisons per address', () => {
    expect(
      applyMathOperation('minus', [
        [5, 1],
        [2, 2],
      ])
    ).toEqual([3, 0]);
    expect(
      applyMathOperation('min', [
        [5, 1],
        [2, 2],
      ])
    ).toEqual([2, 1]);
    expect(
      applyMathOperation('max', [
        [5, 1],
        [2, 2],
      ])
    ).toEqual([5, 2]);
    expect(
      applyMathOperation('a-if-lt-b', [
        [5, 1],
        [0, 0],
        [2, 2],
      ])
    ).toEqual([5, 0]);
    expect(
      applyMathOperation('a-if-gte-b', [
        [5, 1],
        [0, 0],
        [2, 2],
      ])
    ).toEqual([0, 1]);
    expect(applyMathOperation('square-root', [[9, 16]])).toEqual([3, 4]);
    expect(applyMathOperation('cube-root', [[8, 27]])).toEqual([2, 3]);
  });
});

describe('mathParamsSchema', () => {
  const read = { type: 'strategy', strategy: { name: 'contract-call', params: {} } };

  it('accepts strategy and constant operands in the count the operation takes', () => {
    expect(mathParamsSchema.safeParse({ operation: 'divide', operands: [read, read] }).success).toBe(true);
    expect(
      mathParamsSchema.safeParse({ operation: 'multiply', operands: [read, { type: 'constant', value: 2 }] }).success
    ).toBe(true);
    expect(mathParamsSchema.safeParse({ operation: 'square-root', operands: [read] }).success).toBe(true);
  });

  it('rejects an operand count that does not fit the operation and unknown operations', () => {
    expect(mathParamsSchema.safeParse({ operation: 'divide', operands: [read] }).success).toBe(false);
    expect(mathParamsSchema.safeParse({ operation: 'square-root', operands: [read, read] }).success).toBe(false);
    expect(mathParamsSchema.safeParse({ operation: 'power', operands: [read, read] }).success).toBe(false);
  });
});
