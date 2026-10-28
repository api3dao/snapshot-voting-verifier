import { describe, expect, it } from 'vitest';

import { type HubSettingsMessage } from '../src/hub';
import { PINNED_SETTINGS, type SpaceSettings, settingsDifferences, settingsProblems } from '../src/settings';

const pinned = PINNED_SETTINGS['api3.eth']!;

// What the hub copies onto a proposal posted under the pinned settings
const proposal = {
  network: pinned.network,
  strategies: structuredClone(pinned.strategies),
  privacy: '',
  validation: { name: 'any', params: {} },
};

const settingsWith = (change: (settings: Record<string, any>) => void) => {
  const settings = structuredClone(pinned) as Record<string, any>;
  change(settings);
  return settings as SpaceSettings;
};

const change: HubSettingsMessage = { id: '0xabc', mci: 2, timestamp: 1_793_200_000, ipfs: 'bafkrei' };

describe('settingsDifferences', () => {
  it('finds none between the pinned settings and the same settings with their keys reordered', () => {
    const reordered = Object.fromEntries(Object.entries(pinned).reverse()) as SpaceSettings;

    expect(settingsDifferences(pinned, reordered)).toEqual([]);
  });

  it('ignores how the space presents itself', () => {
    const presented = settingsWith((settings) => {
      settings.about = 'Something else';
      settings.discussions = 'https://example.com';
      settings.treasuries = [];
      settings.avatar = 'ipfs://bafkrei';
    });

    expect(settingsDifferences(pinned, presented)).toEqual([]);
  });

  it('names every governance field that changed', () => {
    const changed = settingsWith((settings) => {
      settings.voteValidation = { name: 'basic', params: { minScore: 1 } };
      settings.filters.onlyMembers = true;
      settings.voting.privacy = 'shutter';
      settings.moderators = ['0x0000000000000000000000000000000000000001'];
      settings.strategies[0].params.strategies.pop();
    });

    expect(settingsDifferences(pinned, changed)).toEqual([
      'strategies',
      'voting',
      'voteValidation',
      'filters',
      'moderators',
    ]);
  });
});

describe('settingsProblems', () => {
  it('passes a proposal posted under the pinned settings with no change while it was open', () => {
    expect(settingsProblems(pinned, proposal, pinned, [])).toEqual([]);
  });

  it('reports settings in force that differ from the pinned ones, or none at all', () => {
    const inForce = settingsWith((settings) => {
      settings.validation.params.minScore = 1;
    });

    expect(settingsProblems(pinned, proposal, inForce, [])).toEqual([
      'space settings in force at posting differ from the pinned ones in validation',
    ]);
    expect(settingsProblems(pinned, proposal, undefined, [])).toEqual([
      'the hub has no settings message for the space before the proposal',
    ]);
  });

  it('reports what the hub copied onto the proposal when it differs from the pinned settings', () => {
    const copied = {
      network: '11155111',
      strategies: proposal.strategies.slice(0, 0),
      privacy: 'shutter',
      validation: { name: 'basic', params: { minScore: 1 } },
    };

    expect(settingsProblems(pinned, copied, pinned, [])).toEqual([
      'proposal network 11155111, 1 pinned',
      'proposal strategies differ from the pinned ones',
      'proposal privacy "shutter", "" pinned',
      'proposal vote validation basic differs from the pinned one',
    ]);
  });

  it('lets the author choose the privacy where the settings allow any', () => {
    const anyPrivacy = settingsWith((settings) => {
      settings.voting.privacy = 'any';
    });

    expect(settingsProblems(anyPrivacy, { ...proposal, privacy: 'shutter' }, anyPrivacy, [])).toEqual([]);
  });

  it('reports a settings change the hub may have received while voting was open', () => {
    expect(settingsProblems(pinned, proposal, pinned, [change])).toEqual([
      'space settings changed while voting was open, message 0xabc signed 2026-10-28T15:06:40.000Z',
    ]);
  });
});
