import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { type HubVote } from './hub';

const archivedVoteSchema = z.strictObject({
  id: z.string(),
  ipfs: z.string(),
  voter: z.string(),
  choice: z.unknown(),
  vp: z.number(),
  vp_by_strategy: z.array(z.number()),
  vp_state: z.string(),
  created: z.number(),
});

type ArchivedVote = z.infer<typeof archivedVoteSchema>;

const archiveSchema = z.strictObject({
  proposal: z.string(),
  archivedAt: z.string(),
  votes: z.array(archivedVoteSchema),
});

export type VoteDiff = {
  added: ArchivedVote[];
  removed: ArchivedVote[];
  changed: { before: ArchivedVote; after: ArchivedVote }[];
};

const toArchived = (vote: HubVote): ArchivedVote => ({
  id: vote.id,
  ipfs: vote.ipfs,
  voter: vote.voter,
  choice: vote.choice,
  vp: vote.vp,
  vp_by_strategy: vote.vp_by_strategy,
  vp_state: vote.vp_state,
  created: vote.created,
});

export const diffVotes = (before: ArchivedVote[], after: ArchivedVote[]): VoteDiff => {
  const beforeById = new Map(before.map((vote) => [vote.id, vote]));
  const afterById = new Map(after.map((vote) => [vote.id, vote]));
  const diff: VoteDiff = { added: [], removed: [], changed: [] };
  for (const vote of after) {
    const previous = beforeById.get(vote.id);
    if (!previous) diff.added.push(vote);
    else if (JSON.stringify(previous) !== JSON.stringify(vote)) diff.changed.push({ before: previous, after: vote });
  }
  for (const vote of before) if (!afterById.has(vote.id)) diff.removed.push(vote);
  return diff;
};

// Stores the vote list under the proposal and reports what changed since the previous run, so a vote inserted or
// dropped after the fact shows up as long as the tool ran while the vote was open
export const archiveVotes = (archiveDir: string, proposalId: string, votes: HubVote[], archivedAt: Date) => {
  const dir = join(archiveDir, proposalId);
  mkdirSync(dir, { recursive: true });
  const previousFiles = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const previous =
    previousFiles.length > 0
      ? archiveSchema.parse(JSON.parse(readFileSync(join(dir, previousFiles.at(-1)!), 'utf8'))).votes
      : null;
  const current = votes.map((vote) => toArchived(vote));
  const file = join(dir, `${archivedAt.toISOString().replaceAll(':', '-')}.json`);
  if (existsSync(file)) throw new Error(`Archive file ${file} already exists`);
  writeFileSync(
    file,
    `${JSON.stringify({ proposal: proposalId, archivedAt: archivedAt.toISOString(), votes: current }, null, 2)}\n`
  );
  return { file, diff: previous ? diffVotes(previous, current) : null };
};
