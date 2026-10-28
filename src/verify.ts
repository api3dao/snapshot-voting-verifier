import { go } from '@api3/promise-utils';
import { BlockNotFoundError, type PublicClient } from 'viem';

import { archiveVotes } from './archive';
import { type HubProposal, type HubVote, fetchProposal, fetchReceivedAfter, fetchVotes } from './hub';
import { type StrategyPower, computePowers } from './power';
import { RULE_SETS, type RulesResult, checkRules } from './rules';
import { verifyVoteSignature } from './signature';
import { parseBasicChoice, scoresMatch, tallyBasic } from './tally';

export const SUPPORTED_PROPOSAL_TYPES = ['basic', 'single-choice'];

// The snapshot block may be no deeper than this before the hub received the proposal (section 4.1 of the migration
// proposal). The author picks it and the sequencer only checks that the block exists, so without a ceiling a proposal
// could count balances from years ago, tokens since sold and delegations since revoked included. About a day of
// blocks, so a Safe that signs a proposal with the latest block has a day to collect the other signatures and deliver
// it. There is no floor: snapshot.box picks the latest block, and a reorg in the first minutes cannot reach the
// result, since the hub recomputes every vote's power until the proposal closes and this tool reads after finality
export const MAX_SNAPSHOT_AGE_BLOCKS = 7200n;

// Judged by when the block MAX_SNAPSHOT_AGE_BLOCKS after the snapshot block was mined, undefined while it is not yet
export const snapshotAgeProblems = (receivedAfter: number, afterMaxAge: number | undefined) =>
  afterMaxAge !== undefined && afterMaxAge < receivedAfter
    ? [`snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the hub received the proposal`]
    : [];

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
  // Since 2026-10-26 at the latest the hub sets `created` to when it received the proposal, moving `start` and `end`
  // with it, whenever the signed timestamp is earlier. On an older proposal `created` is the signed timestamp, which
  // the sequencer takes up to six days old, and the messages received right before it bound the receipt instead
  const receivedAfter = Math.max(await fetchReceivedAfter(proposalId), proposal.created);
  const snapshotTimestamp = await blockTimestamp(client, proposal.snapshot);
  const afterMaxAge = await blockTimestampIfMined(client, proposal.snapshot + MAX_SNAPSHOT_AGE_BLOCKS);
  problems.push(...snapshotAgeProblems(receivedAfter, afterMaxAge));

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
