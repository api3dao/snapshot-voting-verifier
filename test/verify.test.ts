import { describe, expect, it } from 'vitest';

import {
  MAX_SNAPSHOT_AGE_BLOCKS,
  TIMESTAMP_TOLERANCE_SECONDS,
  snapshotAgeProblems,
  timestampProblems,
} from '../src/verify';

const created = 1_792_500_000;
const SLOT = 12;
const TWO_DAYS = 2 * 86_400;
const tooOld = `snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the proposal was posted`;

// The timestamps of the snapshot block and of the block MAX after it, for a snapshot `age` blocks before `reference`
const neighbourhood = (age: bigint, reference = created) => ({
  snapshot: reference - Number(age) * SLOT,
  afterMaxAge: reference - Number(age - MAX_SNAPSHOT_AGE_BLOCKS) * SLOT,
});

// A promptly sent proposal: the hub's receipt bound sits a few seconds before the signature
const receivedAfter = created - 5;

describe('snapshotAgeProblems', () => {
  it("accepts Snapshot's default, the latest block at creation", () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(1n))).toEqual([]);
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(0n))).toEqual([]);
  });

  it('accepts a block up to the maximum age', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(100n))).toEqual([]);
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MAX_SNAPSHOT_AGE_BLOCKS))).toEqual([]);
  });

  it('accepts a recent block whose maximum age block is not mined yet', () => {
    expect(snapshotAgeProblems(created, receivedAfter, { ...neighbourhood(100n), afterMaxAge: undefined })).toEqual([]);
  });

  it('accepts a block of the latest kind delivered a day after it was signed, the Safe case', () => {
    // Signed against the latest block, received a day later: the block is at the maximum age at receipt
    expect(snapshotAgeProblems(created, created + 86_400, neighbourhood(0n))).toEqual([]);
  });

  it('rejects a block one past the maximum age', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MAX_SNAPSHOT_AGE_BLOCKS + 1n))).toEqual([tooOld]);
  });

  it('rejects a block from years ago, which the sequencer accepts', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(10_000_000n))).toEqual([tooOld]);
  });

  it('rejects a block after the signed timestamp', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(-5n))).toEqual([
      'snapshot block is later than the signed timestamp',
    ]);
  });

  it('judges the maximum age against the receipt, so a backdated signature cannot age a block into the window', () => {
    // Signed two days ago against a block 100 blocks before that signature, received now
    const backdated = created - TWO_DAYS;

    expect(snapshotAgeProblems(backdated, created, neighbourhood(100n, backdated))).toEqual([tooOld]);
  });
});

describe('timestampProblems', () => {
  it('accepts a proposal signed up to a day before the hub received it', () => {
    expect(timestampProblems(created, created + 30)).toEqual([]);
    expect(timestampProblems(created, created + TIMESTAMP_TOLERANCE_SECONDS)).toEqual([]);
  });

  it('accepts a receipt bound before the signature, the neighbours were quiet', () => {
    expect(timestampProblems(created, created - 500)).toEqual([]);
  });

  it('rejects a signature more than a day before the receipt', () => {
    expect(timestampProblems(created - TWO_DAYS, created)).toEqual([
      `proposal was signed ${TWO_DAYS} seconds before the hub received it, more than a day`,
    ]);
  });
});
