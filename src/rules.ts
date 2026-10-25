// The rules of the API3 DAO's governance (section 4 of the migration proposal, version 1.0) that Snapshot does not
// enforce, or enforces only through space settings the controller could change: the tool computes the list from the
// recomputed result and the signers tick it before executing. Every figure here is the proposal's own, not the hub's

export interface RuleSet {
  // Votes in favour. Snapshot's own quorum counts every vote cast, this one does not
  quorum: number;
  // Seconds from the signed timestamp to the start of voting, and the length of voting
  delay: number;
  period: number;
  // Voting power the proposer needs at posting
  minScore: number;
}

export const RULE_SETS: Record<string, RuleSet> = {
  'api3.eth': { quorum: 10_000_000, delay: 0, period: 7 * 86_400, minScore: 500_000 },
  // The rehearsal space, running the production settings with the thresholds scaled, a minute of delay and, since
  // 2026-10-22, the production week of voting (the rounds of 2026-10-20 ran 30 minutes)
  'testing-new-d-ignore-xyz-a.eth': { quorum: 300, delay: 60, period: 7 * 86_400, minScore: 5 },
};

export interface RuleCheck {
  ok: boolean;
  text: string;
  // A failed check that means the space's rules were bypassed. It goes into the verification's problems, as opposed
  // to a check that only says whether the proposal passed
  bypass: boolean;
}

export interface RulesResult {
  checks: RuleCheck[];
  // The one line the signers act on
  outcome: string;
  passed: boolean;
}

export interface RuledProposal {
  type: string;
  created: number;
  start: number;
  end: number;
  quorum: number;
  choices: string[];
}

const BASIC_CHOICES = ['For', 'Against', 'Abstain'];

const format = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 6 });

const duration = (seconds: number) => {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${seconds} seconds`;
};

const delayText = (delay: number, expected: number) => {
  if (delay !== expected) {
    return `delay of ${delay} seconds between the signed timestamp and the start, ${expected} expected`;
  }
  return expected === 0 ? 'no delay, voting opened at the signed timestamp' : `delay of ${duration(delay)}`;
};

// `scores` are the recomputed totals per choice, `authorPower` the proposer's power at the snapshot block
export const checkRules = (
  rules: RuleSet,
  proposal: RuledProposal,
  scores: number[],
  author: string,
  authorPower: number
): RulesResult => {
  const checks: RuleCheck[] = [];
  const check = (ok: boolean, text: string, bypass = true) => checks.push({ ok, text, bypass });

  const basic =
    proposal.type === 'basic' &&
    proposal.choices.length === 3 &&
    proposal.choices.every((c, i) => c === BASIC_CHOICES[i]);
  check(
    basic,
    basic ? 'basic proposal, For, Against and Abstain' : `${proposal.type} proposal, the rules are for basic ones`
  );

  check(
    authorPower >= rules.minScore,
    `proposer ${author} holds ${format(authorPower)} at the snapshot block, ${format(rules.minScore)} needed (the sequencer checked the latest block when it received the proposal)`
  );

  const delay = proposal.start - proposal.created;
  check(delay === rules.delay, delayText(delay, rules.delay));

  const period = proposal.end - proposal.start;
  check(
    period === rules.period,
    period === rules.period
      ? `voting period of ${duration(period)}`
      : `voting period of ${period} seconds, ${rules.period} expected`
  );

  check(
    proposal.quorum === rules.quorum,
    proposal.quorum === rules.quorum
      ? `quorum of ${format(rules.quorum)} as set`
      : `quorum of ${format(proposal.quorum)} set on the proposal, ${format(rules.quorum)} expected`
  );

  // Abstain is off the ballot, the hidden choice can still be cast through the API and counts for nothing here,
  // although Snapshot's own quorum bar includes it
  const [forScore = 0, againstScore = 0, abstainScore = 0] = scores;
  const quorumReached = forScore >= rules.quorum;
  check(
    quorumReached,
    `${format(forScore)} in favour, quorum ${format(rules.quorum)} ${quorumReached ? 'reached' : 'not reached'}${
      abstainScore > 0 ? ` (${format(abstainScore)} abstained, counted for nothing)` : ''
    }`,
    false
  );

  const majority = forScore > againstScore;
  check(
    majority,
    `${format(forScore)} for, ${format(againstScore)} against, more for than against ${majority ? 'reached' : 'not reached'}`,
    false
  );

  const bypassed = checks.some((c) => !c.ok && c.bypass);
  const passed = !bypassed && quorumReached && majority;
  let outcome: string;
  if (bypassed) {
    outcome = 'not to be executed, a rule was bypassed';
  } else if (!quorumReached) {
    outcome = 'rejected, quorum not reached';
  } else if (majority) {
    outcome = 'passed';
  } else {
    outcome = 'rejected, not more for than against';
  }
  return { checks, outcome, passed };
};
