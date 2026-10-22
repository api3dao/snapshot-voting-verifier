import { describe, expect, it } from 'vitest';

import {
  MAX_SNAPSHOT_AGE_BLOCKS,
  MIN_SNAPSHOT_AGE_BLOCKS,
  TIMESTAMP_TOLERANCE_SECONDS,
  snapshotAgeProblems,
  timestampProblems,
  timestampTolerance,
} from '../src/verify';

const created = 1_792_500_000;
const SLOT = 12;
const TWO_DAYS = 2 * 86_400;
const tooFresh = `snapshot block is fewer than ${MIN_SNAPSHOT_AGE_BLOCKS} blocks before the proposal creation`;
const tooOld = `snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the proposal was posted`;

// The timestamps of the snapshot block and of the blocks MIN and MAX after it, for a snapshot `age` blocks before
// `reference`
const neighbourhood = (age: bigint, reference = created) => ({
  snapshot: reference - Number(age) * SLOT,
  afterMinAge: reference - Number(age - MIN_SNAPSHOT_AGE_BLOCKS) * SLOT,
  afterMaxAge: reference - Number(age - MAX_SNAPSHOT_AGE_BLOCKS) * SLOT,
});

// A promptly sent proposal: the hub's receipt bound sits a few seconds before the signature
const receivedAfter = created - 5;

describe('snapshotAgeProblems', () => {
  it('accepts a block between the minimum and the maximum age', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(100n))).toEqual([]);
  });

  it('accepts the bounds themselves', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MIN_SNAPSHOT_AGE_BLOCKS))).toEqual([]);
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MAX_SNAPSHOT_AGE_BLOCKS))).toEqual([]);
  });

  it('accepts a recent block whose maximum age block is not mined yet', () => {
    expect(snapshotAgeProblems(created, receivedAfter, { ...neighbourhood(100n), afterMaxAge: undefined })).toEqual([]);
  });

  it("rejects Snapshot's default, the latest block at creation", () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(1n))).toEqual([tooFresh]);
  });

  it('rejects a block one short of the minimum age', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MIN_SNAPSHOT_AGE_BLOCKS - 1n))).toEqual([
      tooFresh,
    ]);
  });

  it('rejects a block one past the maximum age', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(MAX_SNAPSHOT_AGE_BLOCKS + 1n))).toEqual([tooOld]);
  });

  it('rejects a block from years ago, which the sequencer accepts', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(10_000_000n))).toEqual([tooOld]);
  });

  it('rejects a block after the creation', () => {
    expect(snapshotAgeProblems(created, receivedAfter, neighbourhood(-5n))).toEqual([
      'snapshot block is later than the proposal creation',
      tooFresh,
    ]);
  });

  it('judges the maximum age against the receipt, so a backdated signature cannot age a block into the window', () => {
    // Signed two days ago against a block 100 blocks before that signature, received now
    const backdated = created - TWO_DAYS;

    expect(snapshotAgeProblems(backdated, created, neighbourhood(100n, backdated))).toEqual([tooOld]);
  });
});

describe('timestampTolerance', () => {
  it('is an hour on a space with a long delay and half the delay on a short one', () => {
    expect(timestampTolerance(TWO_DAYS)).toBe(TIMESTAMP_TOLERANCE_SECONDS);
    expect(timestampTolerance(60)).toBe(30);
    expect(timestampTolerance(0)).toBe(TIMESTAMP_TOLERANCE_SECONDS);
  });
});

describe('timestampProblems', () => {
  it('accepts a proposal signed shortly before the hub received it', () => {
    expect(timestampProblems(created, created + 30, TWO_DAYS)).toEqual([]);
    expect(timestampProblems(created, created + TIMESTAMP_TOLERANCE_SECONDS, TWO_DAYS)).toEqual([]);
  });

  it('accepts a receipt bound before the signature, the neighbours were quiet', () => {
    expect(timestampProblems(created, created - 500, TWO_DAYS)).toEqual([]);
  });

  it('rejects a backdated signature, which skips the delay by that much', () => {
    expect(timestampProblems(created - TWO_DAYS, created, TWO_DAYS)).toEqual([
      `proposal timestamp is ${TWO_DAYS} seconds before the hub received it, the voting window is shifted back by that much`,
    ]);
  });

  it('rejects twenty minutes of backdating on a space with a one minute delay', () => {
    expect(timestampProblems(created - 1200, created, 60)).toEqual([
      'proposal timestamp is 1200 seconds before the hub received it, the voting window is shifted back by that much',
    ]);
  });
});
