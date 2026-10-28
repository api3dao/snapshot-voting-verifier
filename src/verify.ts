import { go } from '@api3/promise-utils';
import { BlockNotFoundError, type PublicClient } from 'viem';

import { archiveVotes } from './archive';
import { type HubProposal, type HubVote, fetchProposal, fetchProposalTimes, fetchVotes } from './hub';
import { type StrategyPower, computePowers } from './power';
import { RULE_SETS, type RulesResult, checkRules } from './rules';
import { verifyVoteSignature } from './signature';
import { parseBasicChoice, scoresMatch, tallyBasic } from './tally';

export const SUPPORTED_PROPOSAL_TYPES = ['basic', 'single-choice'];

// The snapshot block may be no deeper than this. The author picks it and the sequencer only checks that the block
// exists, so without a ceiling a proposal could count balances from years ago, tokens since sold and delegations
// since revoked included. About a day of blocks, the same day the signed timestamp gets below, so a proposal signed
// with the latest block and delivered within the day passes both. There is no floor: snapshot.box picks the latest
// block, and a reorg in the first minutes cannot reach the result, since the hub recomputes every vote's power until
// the proposal closes and this tool reads after finality
export const MAX_SNAPSHOT_AGE_BLOCKS = 7200n;

// The sequencer takes a signed timestamp up to six days old. Since 2026-10-26 at the latest, the hub sets a proposal's
// `created` to when it received the proposal whenever the signed timestamp is earlier, and moves `start` and `end`
// with it, so a backdated signature no longer shortens voting. Until then `created` was the signed timestamp. The
// signed timestamp stays in the hub's message record, and the DAO still wants it within a day of the receipt
// (section 4.1 of the migration proposal). A day rather than an hour because a Safe signs a proposal first and
// delivers it once the other owners have signed
export const TIMESTAMP_TOLERANCE_SECONDS = 86_400;

export const timestampProblems = (signed: number, receivedAfter: number) =>
  signed + TIMESTAMP_TOLERANCE_SECONDS < receivedAfter
    ? [`proposal was signed ${receivedAfter - signed} seconds before the hub received it, more than a day`]
    : [];

// Block timestamps around the snapshot block: the block itself and the block MAX_SNAPSHOT_AGE_BLOCKS after it,
// undefined while that one is not mined yet
export type SnapshotNeighbourhood = { snapshot: number; afterMaxAge: number | undefined };

// The snapshot block may not be later than the signed timestamp, and no more than MAX blocks before the proposal was
// posted, judged by when the block that far after it was mined. The ceiling is judged against the later of the
// signed timestamp and the hub's receipt bound, so a backdated signature cannot age the block into the window
export const snapshotAgeProblems = (signed: number, receivedAfter: number, blocks: SnapshotNeighbourhood) => {
  const posted = Math.max(signed, receivedAfter);
  const problems: string[] = [];
  if (blocks.snapshot > signed) problems.push('snapshot block is later than the signed timestamp');
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
  const times = await fetchProposalTimes(proposalId);
  // `created` is the receipt itself on a proposal the hub received since the change above
  const receivedAfter = Math.max(times.receivedAfter, proposal.created);
  problems.push(...timestampProblems(times.signed, receivedAfter));
  const snapshotTimestamp = await blockTimestamp(client, proposal.snapshot);
  problems.push(
    ...snapshotAgeProblems(times.signed, receivedAfter, {
      snapshot: snapshotTimestamp,
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
