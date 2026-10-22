import { type VotingPower } from './power';
import { scoreOf } from './strategies';
import { type Verification, type VoterResult } from './verify';

const formatScore = (score: number) => score.toLocaleString('en-US', { maximumFractionDigits: 6 });

const formatDate = (timestamp: number) => new Date(timestamp * 1000).toISOString();

const formatPower = (power: VotingPower, subSymbols: string[]) => {
  const holdings = (scores: VotingPower['own']) =>
    scores.map((score, index) => `${formatScore(scoreOf(score))} ${subSymbols[index]}`).join(', ');
  const delegatedAway = power.delegatedTo ? ` (delegated to ${power.delegatedTo}, not counted)` : '';
  return [
    `    own ${holdings(power.own)}${delegatedAway}`,
    ...power.delegators.map((delegator) => `    from ${delegator.address}: ${holdings(delegator.scores)}`),
  ];
};

const formatVoter = (voter: VoterResult, choices: string[]) => {
  const status = voter.problems.length > 0 ? 'MISMATCH' : 'ok';
  const choice = choices[voter.choice - 1];
  const lines = [
    `${status} ${voter.vote.voter} voted "${choice}" with ${formatScore(voter.score)} (hub ${formatScore(voter.vote.vp)})`,
  ];
  for (const strategyPower of voter.powers) {
    const params = strategyPower.strategy.params as { symbol?: string; strategies?: { params: { symbol?: string } }[] };
    const subSymbols: string[] = (params.strategies ?? [{ params }]).map(
      (sub) => sub.params.symbol ?? params.symbol ?? ''
    );
    const power = strategyPower.powers[0]!;
    lines.push(`  ${strategyPower.strategy.name}: ${formatScore(power.score)}`, ...formatPower(power, subSymbols));
  }
  return [...lines, ...voter.problems.map((problem) => `  ! ${problem}`)];
};

const formatArchiveDiff = (diff: NonNullable<Verification['archiveDiff']>) => [
  `Since the previous archive: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`,
  ...diff.removed.map((vote) => `  removed ${vote.voter} (${vote.id})`),
  ...diff.changed.map(
    ({ before, after }) => `  changed ${after.voter}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
  ),
];

const formatVerdict = (verification: Verification) => {
  const votersWithProblems = verification.voters.filter((voter) => voter.problems.length > 0);
  if (verification.problems.length === 0 && votersWithProblems.length === 0) {
    return ['VERIFIED: every vote and the result match the recomputation'];
  }
  return [
    `NOT VERIFIED: ${verification.problems.length} proposal problems, ${votersWithProblems.length} votes with problems`,
    ...verification.problems.map((problem) => `  ! ${problem}`),
  ];
};

// The space's rules next to the tally, one line per check for the signers to tick, and the outcome they act on
const formatRules = (verification: Verification) => {
  const { proposal, rules } = verification;
  if (!rules) {
    return [`No rule set for ${proposal.space.id}, the hub's quorum is ${formatScore(proposal.quorum)}`];
  }
  return [
    `Rules of ${proposal.space.id}, checked on the recomputed result:`,
    ...rules.checks.map((check) => `  ${check.ok ? 'ok  ' : 'FAIL'} ${check.text}`),
    `Outcome: ${rules.outcome}`,
  ];
};

export const formatReport = (verification: Verification) => {
  const { proposal, voters, scores, archiveDiff } = verification;
  const lines = [
    `Proposal ${proposal.id}`,
    `${proposal.space.id}: ${proposal.title}`,
    `Labels ${proposal.labels.length > 0 ? proposal.labels.join(', ') : 'none'}, proposed by ${proposal.author}`,
    `State ${proposal.state}, hub scores ${proposal.scores_state}, ${voters.length} votes`,
    `Snapshot block ${proposal.snapshot} at ${formatDate(verification.snapshotTimestamp)}, proposal signed ${formatDate(proposal.created)}, received by the hub after ${formatDate(verification.receivedAfter)}`,
    `Voting ${formatDate(proposal.start)} to ${formatDate(proposal.end)}`,
    '',
    ...voters.flatMap((voter) => [...formatVoter(voter, proposal.choices), '']),
    'Result (recomputed, hub):',
    ...proposal.choices.map(
      (choice, index) =>
        `  ${choice}: ${formatScore(scores[index]!)}, ${formatScore(proposal.scores[index] ?? Number.NaN)}`
    ),
    '',
    ...formatRules(verification),
    '',
    `Votes archived to ${verification.archiveFile}`,
    ...(archiveDiff ? formatArchiveDiff(archiveDiff) : []),
    '',
    ...formatVerdict(verification),
  ];
  return lines.join('\n');
};
