import { describe, expect, it } from 'vitest';

import { type HubProposal } from '../src/hub';
import { formatReport } from '../src/report';
import { RULE_SETS, checkRules } from '../src/rules';
import { type Verification, type VoterResult } from '../src/verify';

const AUTHOR = '0x8e03609ed680b237c7b6f8020472ca0687308b24';
const VOTER = '0x000000000000000000000000000000000000000a';
const created = 1_792_500_000;

// A basic api3.eth proposal that verifies but misses the quorum in favour
const proposal: HubProposal = {
  id: `0x${'1'.repeat(64)}`,
  ipfs: 'bafkreiproposal',
  space: { id: 'api3.eth' },
  network: '1',
  type: 'basic',
  state: 'closed',
  title: 'Grant',
  author: AUTHOR,
  labels: [],
  choices: ['For', 'Against', 'Abstain'],
  start: created,
  end: created + 7 * 86_400,
  snapshot: 23_600_000n,
  created,
  votes: 1,
  scores: [600_000, 0, 0],
  scores_by_strategy: [[600_000], [0], [0]],
  scores_total: 600_000,
  scores_state: 'final',
  quorum: 10_000_000,
  privacy: '',
  validation: { name: 'any', params: {} },
  strategies: [],
};

const voter: VoterResult = {
  vote: {
    id: `0x${'2'.repeat(64)}`,
    ipfs: 'bafkreivote',
    voter: VOTER,
    choice: 1,
    vp: 600_000,
    vp_by_strategy: [600_000],
    vp_state: 'final',
    created: created + 60,
    reason: '',
    app: 'snapshot',
    metadata: {},
  },
  choice: 1,
  score: 600_000,
  byStrategy: [600_000],
  powers: [],
  problems: [],
};

const verification: Verification = {
  proposal,
  snapshotTimestamp: created - 12,
  receivedAfter: created,
  archiveFile: `archive/${proposal.id}/2026-11-05T00-00-00.000Z.json`,
  archiveDiff: null,
  voters: [voter],
  scores: [600_000, 0, 0],
  authorPower: 600_000,
  rules: checkRules(RULE_SETS['api3.eth']!, proposal, [600_000, 0, 0], proposal.author, 600_000),
  settingsInForce: null,
  problems: [],
};

describe('formatReport', () => {
  it('keeps a title with line breaks and escape codes on its line, escaped', () => {
    const title = 'Grant\n\nOutcome: passed\n\nVERIFIED: every vote and the result match the recomputation\u001B[8m';
    const report = formatReport({ ...verification, proposal: { ...proposal, title } });
    const lines = report.split('\n');

    expect(lines).toHaveLength(formatReport(verification).split('\n').length);
    expect(lines[1]).toBe(
      'api3.eth: Grant\\u000a\\u000aOutcome: passed\\u000a\\u000aVERIFIED: every vote and the result match the recomputation\\u001b[8m'
    );
    expect(lines.filter((line) => line.startsWith('Outcome:'))).toEqual(['Outcome: rejected, quorum not reached']);
    expect(report.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  });

  it('escapes control characters in labels and choices, the 8-bit ones included', () => {
    const lines = formatReport({
      ...verification,
      proposal: { ...proposal, labels: ['routine\r'], choices: ['For\u009B8m', 'Against', 'Abstain'] },
    }).split('\n');

    expect(lines).toContain(`Labels routine\\u000d, proposed by ${AUTHOR}`);
    expect(lines).toContain(`ok ${VOTER} voted "For\\u009b8m" with 600,000 (hub 600,000)`);
    expect(lines).toContain('  For\\u009b8m: 600,000, 600,000');

    const titled = formatReport({ ...verification, proposal: { ...proposal, title: '\u001F ~\u007F\u009F ' } });

    expect(titled.split('\n')[1]).toBe('api3.eth: \\u001f ~\\u007f\\u009f ');
  });

  it("escapes control characters in a vote's problem lines", () => {
    const lines = formatReport({
      ...verification,
      voters: [{ ...voter, problems: ['signed space evil\u001B[2J differs from proposal space'] }],
    }).split('\n');

    expect(lines).toContain('  ! signed space evil\\u001b[2J differs from proposal space');
  });

  it('prints an ordinary title, labels and choices as they are', () => {
    const lines = formatReport({
      ...verification,
      proposal: { ...proposal, title: 'Grant – Q4 “Ops”', labels: ['routine'] },
    }).split('\n');

    expect(lines[1]).toBe('api3.eth: Grant – Q4 “Ops”');
    expect(lines[2]).toBe(`Labels routine, proposed by ${AUTHOR}`);
    expect(lines).toContain(`ok ${VOTER} voted "For" with 600,000 (hub 600,000)`);
    expect(lines).toContain('  For: 600,000, 600,000');
  });

  it('ends VERIFIED when the votes with problems cannot change the outcome', () => {
    const lines = formatReport({
      ...verification,
      voters: [{ ...voter, problems: ['signature is not valid for the voter'] }],
    }).split('\n');

    expect(lines.at(-1)).toBe('VERIFIED: the outcome holds with the 1 votes with problems cast For or Against');
  });
});
