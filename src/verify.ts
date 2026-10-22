import { go } from '@api3/promise-utils';
import { BlockNotFoundError, type PublicClient } from 'viem';

import { archiveVotes } from './archive';
import { type HubProposal, type HubVote, fetchProposal, fetchReceivedAfter, fetchVotes } from './hub';
import { type StrategyPower, computePowers } from './power';
import { RULE_SETS, type RulesResult, checkRules } from './rules';
import { verifyVoteSignature } from './signature';
import { parseBasicChoice, scoresMatch, tallyBasic } from './tally';

export const SUPPORTED_PROPOSAL_TYPES = ['basic', 'single-choice'];

// Reorgs cannot reach a block this deep, two epochs of finality
export const MIN_SNAPSHOT_AGE_BLOCKS = 64n;
// And no deeper than this. The author picks the snapshot block and the sequencer only checks that the block exists,
// so without a ceiling a proposal could count balances from years ago, tokens since sold and delegations since
// revoked included. About an hour of blocks, enough to post against a block that is already final.
export const MAX_SNAPSHOT_AGE_BLOCKS = 300n;

// A proposal's `created` is the timestamp its author signed, and the sequencer takes one up to six days old. Since
// `start` has to be `created` plus the space's delay and `end` is `start` plus the period, a backdated signature
// opens voting early and shortens it, and moves the window the snapshot block is judged against. The hub's receipt
// time is the reference instead. A sender who signs and sends within the hour, or within half the delay on a space
// with a delay shorter than two hours, is never flagged
export const TIMESTAMP_TOLERANCE_SECONDS = 3600;

export const timestampTolerance = (delay: number) =>
  delay > 0 ? Math.min(TIMESTAMP_TOLERANCE_SECONDS, Math.floor(delay / 2)) : TIMESTAMP_TOLERANCE_SECONDS;

export const timestampProblems = (created: number, receivedAfter: number, delay: number) =>
  created + timestampTolerance(delay) < receivedAfter
    ? [
        `proposal timestamp is ${receivedAfter - created} seconds before the hub received it, the voting window is shifted back by that much`,
      ]
    : [];

// Block timestamps around the snapshot block: the block itself, the block MIN_SNAPSHOT_AGE_BLOCKS after it, and the
// block MAX_SNAPSHOT_AGE_BLOCKS after it, undefined while that one is not mined yet
export type SnapshotNeighbourhood = { snapshot: number; afterMinAge: number; afterMaxAge: number | undefined };

// The snapshot block has to be between MIN and MAX blocks before the proposal was posted, judged by when the blocks
// that far after it were mined. The floor is judged against the signed timestamp, the ceiling against the later of
// that and the hub's receipt bound, so a backdated signature cannot age the block into the window
export const snapshotAgeProblems = (created: number, receivedAfter: number, blocks: SnapshotNeighbourhood) => {
  const posted = Math.max(created, receivedAfter);
  const problems: string[] = [];
  if (blocks.snapshot > created) problems.push('snapshot block is later than the proposal creation');
  if (blocks.afterMinAge > created) {
    problems.push(`snapshot block is fewer than ${MIN_SNAPSHOT_AGE_BLOCKS} blocks before the proposal creation`);
  }
  if (blocks.afterMaxAge !== undefined && blocks.afterMaxAge < posted) {
    problems.push(`snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the proposal was posted`);
  }
  return problems;
};

const blockTimestamp = async (client: PublicClient, blockNumber: bigint) => {
  const block = await client.getBlock({ blockNumber });
  return Number(block.timestamp);
};

// Undefined while the block is not mined yet, any other failure is thrown
const blockTimestampIfMined = async (client: PublicClient, blockNumber: bigint) => {
  const result = await go(() => blockTimestamp(client, blockNumber));
  if (result.success) return result.data;
  if (result.error instanceof BlockNotFoundError) return;
  throw result.error;
};

export type VoterResult = {
  vote: HubVote;
  choice: number;
  score: number;
  byStrategy: number[];
  powers: StrategyPower[];
  problems: string[];
};

export type Verification = {
  proposal: HubProposal;
  snapshotTimestamp: number;
  receivedAfter: number;
  archiveFile: string;
  archiveDiff: ReturnType<typeof archiveVotes>['diff'];
  voters: VoterResult[];
  scores: number[];
  // The proposer's power at the snapshot block
  authorPower: number;
  // The space's rules checked on the recomputed result, null for a space without a known rule set
  rules: RulesResult | null;
  problems: string[];
};

export const verifyProposal = async (
  client: PublicClient,
  proposalId: string,
  archiveDir: string,
  now: Date
): Promise<Verification> => {
  const proposal = await fetchProposal(proposalId);
  if (!SUPPORTED_PROPOSAL_TYPES.includes(proposal.type)) {
    throw new Error(`Proposal type ${proposal.type} is not supported`);
  }
  const votes = await fetchVotes(proposalId);
  const archive = archiveVotes(archiveDir, proposalId, votes, now);
  const problems: string[] = [];

  if (votes.length !== proposal.votes) problems.push(`hub counts ${proposal.votes} votes but lists ${votes.length}`);
  if (proposal.scores_state !== 'final') problems.push(`hub scores are ${proposal.scores_state}, not final`);
  const receivedAfter = await fetchReceivedAfter(proposalId);
  problems.push(...timestampProblems(proposal.created, receivedAfter, proposal.start - proposal.created));
  const snapshotTimestamp = await blockTimestamp(client, proposal.snapshot);
  problems.push(
    ...snapshotAgeProblems(proposal.created, receivedAfter, {
      snapshot: snapshotTimestamp,
      afterMinAge: await blockTimestamp(client, proposal.snapshot + MIN_SNAPSHOT_AGE_BLOCKS),
      afterMaxAge: await blockTimestampIfMined(client, proposal.snapshot + MAX_SNAPSHOT_AGE_BLOCKS),
    })
  );

  // The proposer's power is read along with the voters', at the same block
  const voterAddresses = votes.map((vote) => vote.voter);
  const addresses = [...new Set([...voterAddresses, proposal.author])];
  const strategyPowers = await computePowers(
    client,
    proposal.space.id,
    proposal.strategies,
    addresses,
    proposal.snapshot
  );
  const authorIndex = addresses.indexOf(proposal.author);
  let authorPower = 0;
  for (const strategyPower of strategyPowers) authorPower += strategyPower.powers[authorIndex]!.score;

  const voters: VoterResult[] = [];
  for (const [index, vote] of votes.entries()) {
    const voterProblems: string[] = [];
    const byStrategy = strategyPowers.map((strategyPower) => strategyPower.powers[index]!.score);
    let score = 0;
    for (const strategyScore of byStrategy) score += strategyScore;
    if (!scoresMatch(vote.vp, score)) voterProblems.push(`hub power ${vote.vp} differs from recomputed ${score}`);
    if (vote.vp_by_strategy.length !== byStrategy.length) {
      voterProblems.push('hub lists a different number of strategies');
    }
    for (const [strategyIndex, hubScore] of vote.vp_by_strategy.entries()) {
      const ours = byStrategy[strategyIndex];
      if (ours !== undefined && !scoresMatch(hubScore, ours)) {
        voterProblems.push(`strategy ${strategyIndex} hub power ${hubScore} differs from recomputed ${ours}`);
      }
    }
    if (vote.vp_state !== 'final') voterProblems.push(`hub power is ${vote.vp_state}, not final`);
    if (vote.created < proposal.start || vote.created > proposal.end) {
      voterProblems.push('cast outside the voting window');
    }
    const choice = parseBasicChoice(vote.choice, proposal.choices.length);
    voterProblems.push(...(await verifyVoteSignature(client, proposal, vote)));
    voters.push({
      vote,
      choice,
      score,
      byStrategy,
      powers: strategyPowers.map((strategyPower) => ({ ...strategyPower, powers: [strategyPower.powers[index]!] })),
      problems: voterProblems,
    });
  }

  const scores = tallyBasic(voters, proposal.choices.length);
  for (const [index, hubScore] of proposal.scores.entries()) {
    if (!scoresMatch(hubScore, scores[index]!)) {
      problems.push(`hub score ${hubScore} for choice ${index + 1} differs from recomputed ${scores[index]}`);
    }
  }

  const ruleSet = RULE_SETS[proposal.space.id];
  const rules = ruleSet ? checkRules(ruleSet, proposal, scores, proposal.author, authorPower) : null;
  for (const check of rules?.checks ?? []) {
    if (!check.ok && check.bypass) problems.push(`rule bypassed: ${check.text}`);
  }

  return {
    proposal,
    snapshotTimestamp,
    receivedAfter,
    archiveFile: archive.file,
    archiveDiff: archive.diff,
    voters,
    scores,
    authorPower,
    rules,
    problems,
  };
};
