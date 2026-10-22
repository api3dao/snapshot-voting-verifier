import { describe, expect, it } from 'vitest';

import { RULE_SETS, type RuledProposal, checkRules, majorityReached } from '../src/rules';

const api3 = RULE_SETS['api3.eth']!;
const AUTHOR = '0x8e03609ed680b237c7b6f8020472ca0687308b24';
const created = 1_792_500_000;

// A proposal posted by the rules: no delay, seven days, the space's quorum
const routine: RuledProposal = {
  type: 'basic',
  labels: ['routine'],
  created,
  start: created,
  end: created + 7 * 86_400,
  quorum: 10_000_000,
  choices: ['For', 'Against', 'Abstain'],
};
const structural: RuledProposal = { ...routine, labels: ['struct'] };

const failed = (proposal: RuledProposal, scores: number[], authorPower = 600_000) =>
  checkRules(api3, proposal, scores, AUTHOR, authorPower).checks.filter((check) => !check.ok);

describe('the api3.eth rule set', () => {
  it('holds the figures of Table 4', () => {
    expect(api3).toEqual({
      quorum: 10_000_000,
      delay: 0,
      period: 604_800,
      minScore: { routine: 500_000, structural: 5_000_000 },
      labels: { routine: 'routine', structural: 'struct' },
    });
  });
});

describe('checkRules', () => {
  it('passes a routine proposal with quorum and more for than against', () => {
    const result = checkRules(api3, routine, [6_000_000, 5_000_000, 0], AUTHOR, 600_000);

    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.kind).toBe('routine');
    expect(result.passed).toBe(true);
    expect(result.outcome).toBe('passed as Routine');
  });

  it('counts abstain toward the quorum and nothing else', () => {
    const result = checkRules(api3, routine, [1, 0, 9_999_999], AUTHOR, 600_000);

    expect(result.passed).toBe(true);
    expect(failed(routine, [1, 0, 9_999_998])).toEqual([
      expect.objectContaining({ text: '9,999,999 cast with abstain, quorum 10,000,000 not reached', bypass: false }),
    ]);
  });

  it('rejects a routine proposal with as many against as for', () => {
    const result = checkRules(api3, routine, [5_000_000, 5_000_000, 0], AUTHOR, 600_000);

    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('rejected, the routine majority was not reached');
    expect(result.checks.filter((check) => !check.ok).map((check) => check.bypass)).toEqual([false]);
  });

  it('needs two thirds of for and against for a structural proposal, abstain aside', () => {
    expect(checkRules(api3, structural, [6_000_000, 3_000_000, 1_000_000], AUTHOR, 5_000_000).passed).toBe(true);
    expect(checkRules(api3, structural, [6_000_000, 3_000_001, 1_000_000], AUTHOR, 5_000_000).passed).toBe(false);
    expect(checkRules(api3, structural, [6_000_000, 3_000_001, 1_000_000], AUTHOR, 5_000_000).outcome).toBe(
      'rejected, the structural majority was not reached'
    );
  });

  it('holds the proposer to 500,000 for a routine and 5,000,000 for a structural proposal', () => {
    expect(failed(routine, [6_000_000, 0, 5_000_000], 500_000)).toEqual([]);
    expect(failed(routine, [6_000_000, 0, 5_000_000], 499_999.5).map((check) => check.text)).toEqual([
      `proposer ${AUTHOR} holds 499,999.5 at the snapshot block, 500,000 needed (the sequencer checked the latest block when it received the proposal)`,
    ]);
    expect(failed(structural, [8_000_000, 0, 3_000_000], 4_999_999)).toHaveLength(1);
    expect(failed(structural, [8_000_000, 0, 3_000_000], 5_000_000)).toEqual([]);
  });

  it('reports a delay, a short period and a changed quorum as bypasses', () => {
    const shifted = { ...routine, start: created + 60, end: created + 60 + 6 * 86_400, quorum: 1 };
    const result = checkRules(api3, shifted, [6_000_000, 0, 5_000_000], AUTHOR, 600_000);

    expect(result.checks.filter((check) => !check.ok).map((check) => [check.text, check.bypass])).toEqual([
      ['delay of 60 seconds between the signed timestamp and the start, 0 expected', true],
      ['voting period of 518400 seconds, 604800 expected', true],
      ['quorum of 1 set on the proposal, 10,000,000 expected', true],
    ]);
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('not to be executed, a rule was bypassed');
  });

  it('needs exactly one of the two labels', () => {
    for (const labels of [[], ['routine', 'struct'], ['other']]) {
      const result = checkRules(api3, { ...routine, labels }, [6_000_000, 0, 5_000_000], AUTHOR, 600_000);

      expect(result.kind).toBeNull();
      expect(result.passed).toBe(false);
      expect(result.checks[1]).toEqual({
        ok: false,
        text: `labels ${JSON.stringify(labels)}, exactly one of routine and struct is needed`,
        bypass: true,
      });
    }
  });

  it('refuses a proposal that is not a basic For, Against, Abstain one', () => {
    const single = { ...routine, type: 'single-choice', choices: ['Yes', 'No'] };
    const result = checkRules(api3, single, [6_000_000, 5_000_000], AUTHOR, 600_000);

    expect(result.checks[0]).toEqual({
      ok: false,
      text: 'single-choice proposal, the rules are for basic ones',
      bypass: true,
    });
    expect(result.passed).toBe(false);
  });
});

describe('majorityReached', () => {
  it('is more for than against for a routine and two thirds for a structural proposal', () => {
    expect(majorityReached('routine', 2, 1)).toBe(true);
    expect(majorityReached('routine', 1, 1)).toBe(false);
    expect(majorityReached('structural', 2, 1)).toBe(true);
    expect(majorityReached('structural', 2, 1.000_001)).toBe(false);
    expect(majorityReached('structural', 0, 0)).toBe(false);
  });
});
