import { go } from '@api3/promise-utils';
import { BlockNotFoundError, type PublicClient } from 'viem';

import { archiveVotes } from './archive';
import {
  type HubProposal,
  type HubSettingsMessage,
  type HubVote,
  fetchMessageMci,
  fetchProposal,
  fetchReceivedAfter,
  fetchSettingsAfter,
  fetchVotes,
} from './hub';
import { type StrategyPower, computePowers } from './power';
import { RULE_SETS, type RuleSet, type RuledProposal, type RulesResult, checkRules } from './rules';
import { PINNED_SETTINGS, fetchSettingsInForce, settingsProblems } from './settings';
import { verifyVoteSignature } from './signature';
import { parseBasicChoice, scoresMatch, tallyBasic } from './tally';

export const SUPPORTED_PROPOSAL_TYPES = ['basic', 'single-choice'];

// The snapshot block may be no deeper than this before the hub received the proposal, the rule of the migration
// proposal. The author picks it and the sequencer only checks that the block exists, so without a ceiling a proposal
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

// The problems found on a pinned vote, or the first line of the error that kept it from being checked: viem and ox
// add the call data and the RPC URL below it
const pinnedVoteProblems = async (client: PublicClient, proposal: HubProposal, vote: HubVote) => {
  const result = await go(() => verifyVoteSignature(client, proposal, vote));
  return result.success ? result.data : [`pinned vote not checked: ${String(result.error).split('\n')[0]}`];
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
  // The settings message in force when the hub received the proposal, for a space with pinned settings, undefined if
  // the hub has none, null for a space without pinned settings
  settingsInForce: HubSettingsMessage | undefined | null;
  problems: string[];
};

// Votes with problems stay in the tally and hold the proposal back only if the outcome changes with their power, the
// larger of the hub's and the recomputed one, cast For or Against instead, and in a space without a rule set always
export const problemVotesProblems = (
  ruleSet: RuleSet | undefined,
  proposal: RuledProposal & Pick<HubProposal, 'author'>,
  voters: VoterResult[],
  authorPower: number
) => {
  const withProblems = voters.filter((voter) => voter.problems.length > 0);
  if (withProblems.length === 0) return [];
  if (!ruleSet) return ['votes with problems, and no rule set to judge the outcome by'];
  let power = 0;
  for (const voter of withProblems) power += Math.max(voter.vote.vp, voter.score);
  const others = tallyBasic(
    voters.filter((voter) => voter.problems.length === 0),
    proposal.choices.length
  );
  const passedWith = (choice: number) => {
    const scores = others.map((score, index) => (index === choice - 1 ? score + power : score));
    return checkRules(ruleSet, proposal, scores, proposal.author, authorPower).passed;
  };
  return passedWith(1) === passedWith(2) ? [] : [`votes with problems hold ${power}, enough to change the outcome`];
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
  const votes = await fetchVotes(proposalId, proposal.space.id);
  const archive = archiveVotes(archiveDir, proposalId, votes, now);
  const problems: string[] = [];

  if (votes.length !== proposal.votes) problems.push(`hub counts ${proposal.votes} votes but lists ${votes.length}`);
  if (proposal.scores_state !== 'final') problems.push(`hub scores are ${proposal.scores_state}, not final`);
  // Since 2026-10-26 at the latest the hub sets `created` to when it received the proposal, moving `start` and `end`
  // with it, whenever the signed timestamp is earlier. On an older proposal `created` is the signed timestamp, which
  // the sequencer takes up to six days old, and the messages received right before it bound the receipt instead
  const mci = await fetchMessageMci(proposalId);
  const receivedAfter = Math.max(await fetchReceivedAfter(mci), proposal.created);
  const snapshotTimestamp = await blockTimestamp(client, proposal.snapshot);
  const afterMaxAge = await blockTimestampIfMined(client, proposal.snapshot + MAX_SNAPSHOT_AGE_BLOCKS);
  problems.push(...snapshotAgeProblems(receivedAfter, afterMaxAge));

  // The settings the space ran when the hub received the proposal, and any change the hub may have received before
  // the vote closed: a message signed after the close was received after it too
  const pinned = PINNED_SETTINGS[proposal.space.id];
  let settingsInForce: Verification['settingsInForce'] = null;
  if (pinned) {
    const inForce = await fetchSettingsInForce(proposal.space.id, mci);
    settingsInForce = inForce?.message;
    const after = await fetchSettingsAfter(proposal.space.id, mci);
    const changes = after.filter((message) => message.timestamp <= proposal.end);
    problems.push(...settingsProblems(pinned, proposal, inForce?.settings, changes));
  }

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
    voterProblems.push(...(await pinnedVoteProblems(client, proposal, vote)));
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
  // A vote with problems counts at the hub's power here, problemVotesProblems weighs the difference
  const compared = tallyBasic(
    voters.map((voter) => ({ choice: voter.choice, score: voter.problems.length > 0 ? voter.vote.vp : voter.score })),
    proposal.choices.length
  );
  for (const [index, hubScore] of proposal.scores.entries()) {
    if (!scoresMatch(hubScore, compared[index]!)) {
      problems.push(`hub score ${hubScore} for choice ${index + 1} differs from recomputed ${compared[index]}`);
    }
  }

  const ruleSet = RULE_SETS[proposal.space.id];
  const rules = ruleSet ? checkRules(ruleSet, proposal, scores, proposal.author, authorPower) : null;
  for (const check of rules?.checks ?? []) {
    if (!check.ok && check.bypass) problems.push(`rule bypassed: ${check.text}`);
  }
  problems.push(...problemVotesProblems(ruleSet, proposal, voters, authorPower));

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
    settingsInForce,
    problems,
  };
};
