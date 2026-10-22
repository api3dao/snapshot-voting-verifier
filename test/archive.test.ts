import { describe, expect, it } from 'vitest';

import { diffVotes } from '../src/archive';

const vote = (id: string, vp: number) => ({
  id,
  ipfs: `cid-${id}`,
  voter: '0x000000000000000000000000000000000000000a',
  choice: 1,
  vp,
  vp_by_strategy: [vp],
  vp_state: 'final',
  created: 1,
});

describe('diffVotes', () => {
  it('reports added, removed and changed votes', () => {
    const diff = diffVotes([vote('a', 1), vote('b', 2), vote('c', 3)], [vote('a', 1), vote('b', 20), vote('d', 4)]);

    expect(diff.added).toEqual([vote('d', 4)]);
    expect(diff.removed).toEqual([vote('c', 3)]);
    expect(diff.changed).toEqual([{ before: vote('b', 2), after: vote('b', 20) }]);
  });
});
