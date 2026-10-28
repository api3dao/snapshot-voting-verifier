import { describe, expect, it } from 'vitest';

import { MAX_SNAPSHOT_AGE_BLOCKS, snapshotAgeProblems } from '../src/verify';

const received = 1_792_500_000;
const SLOT = 12;
const tooOld = `snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the hub received the proposal`;

// When the block MAX after the snapshot block was mined, for a snapshot `age` blocks before the receipt
const afterMaxAge = (age: bigint) => received - Number(age - MAX_SNAPSHOT_AGE_BLOCKS) * SLOT;

describe('snapshotAgeProblems', () => {
  it("accepts Snapshot's default, the latest block at posting", () => {
    expect(snapshotAgeProblems(received, afterMaxAge(1n))).toEqual([]);
    expect(snapshotAgeProblems(received, afterMaxAge(0n))).toEqual([]);
  });

  it('accepts a block up to the maximum age, a Safe proposal delivered a day after its first signature', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(100n))).toEqual([]);
    expect(snapshotAgeProblems(received, afterMaxAge(MAX_SNAPSHOT_AGE_BLOCKS))).toEqual([]);
  });

  it('accepts a recent block whose maximum age block is not mined yet', () => {
    expect(snapshotAgeProblems(received, undefined)).toEqual([]);
  });

  it('rejects a block one past the maximum age', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(MAX_SNAPSHOT_AGE_BLOCKS + 1n))).toEqual([tooOld]);
  });

  it('rejects a block from years ago, which the sequencer accepts', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(10_000_000n))).toEqual([tooOld]);
  });
});
