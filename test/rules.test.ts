import { describe, expect, it } from 'vitest';

import { RULE_SETS, type RuledProposal, checkRules } from '../src/rules';

const api3 = RULE_SETS['api3.eth']!;
const AUTHOR = '0x8e03609ed680b237c7b6f8020472ca0687308b24';
const created = 1_792_500_000;

// A proposal posted by the rules: no delay, seven days, the space's quorum
const proposal: RuledProposal = {
  type: 'basic',
  created,
  start: created,
  end: created + 7 * 86_400,
  quorum: 10_000_000,
  choices: ['For', 'Against', 'Abstain'],
};

const failed = (ruled: RuledProposal, scores: number[], authorPower = 600_000) =>
  checkRules(api3, ruled, scores, AUTHOR, authorPower).checks.filter((check) => !check.ok);

describe('the api3.eth rule set', () => {
  it('holds the figures of section 4', () => {
    expect(api3).toEqual({ quorum: 10_000_000, delay: 0, period: 604_800, minScore: 500_000 });
  });
});

describe('checkRules', () => {
  it('passes a proposal with 10,000,000 in favour and more for than against', () => {
    const result = checkRules(api3, proposal, [10_000_000, 9_999_999, 0], AUTHOR, 600_000);

    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.outcome).toBe('passed');
  });

  it('counts only the votes in favour toward the quorum', () => {
    expect(failed(proposal, [9_999_999, 0, 1])).toEqual([
      expect.objectContaining({
        text: '9,999,999 in favour, quorum 10,000,000 not reached (1 abstained, counted for nothing)',
        bypass: false,
      }),
    ]);
    expect(checkRules(api3, proposal, [9_999_999, 0, 1], AUTHOR, 600_000).outcome).toBe('rejected, quorum not reached');
    expect(checkRules(api3, proposal, [10_000_000, 0, 50_000_000], AUTHOR, 600_000).passed).toBe(true);
  });

  it('rejects a proposal with as many against as for', () => {
    const result = checkRules(api3, proposal, [15_000_000, 15_000_000, 0], AUTHOR, 600_000);

    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('rejected, not more for than against');
    expect(result.checks.filter((check) => !check.ok).map((check) => check.bypass)).toEqual([false]);
  });

  it('holds the proposer to 500,000', () => {
    expect(failed(proposal, [12_000_000, 0, 0], 500_000)).toEqual([]);
    expect(failed(proposal, [12_000_000, 0, 0], 499_999.5).map((check) => check.text)).toEqual([
      `proposer ${AUTHOR} holds 499,999.5 at the snapshot block, 500,000 needed (the sequencer checked the latest block when it received the proposal)`,
    ]);
  });

  it('reports a delay, a short period and a changed quorum as bypasses', () => {
    const shifted = { ...proposal, start: created + 60, end: created + 60 + 6 * 86_400, quorum: 1 };
    const result = checkRules(api3, shifted, [12_000_000, 0, 0], AUTHOR, 600_000);

    expect(result.checks.filter((check) => !check.ok).map((check) => [check.text, check.bypass])).toEqual([
      ['delay of 60 seconds between the signed timestamp and the start, 0 expected', true],
      ['voting period of 518400 seconds, 604800 expected', true],
      ['quorum of 1 set on the proposal, 10,000,000 expected', true],
    ]);
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('not to be executed, a rule was bypassed');
  });

  it('refuses a proposal that is not a basic For, Against, Abstain one', () => {
    const single = { ...proposal, type: 'single-choice', choices: ['Yes', 'No'] };
    const result = checkRules(api3, single, [12_000_000, 5_000_000], AUTHOR, 600_000);

    expect(result.checks[0]).toEqual({
      ok: false,
      text: 'single-choice proposal, the rules are for basic ones',
      bypass: true,
    });
    expect(result.passed).toBe(false);
  });
});
