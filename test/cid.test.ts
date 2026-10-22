import { describe, expect, it } from 'vitest';

import { cidOf } from '../src/cid';

describe('cidOf', () => {
  it('matches the CID Snapshot pins a vote under', () => {
    // A vote object fetched from the Snapshot gateway, byte for byte
    const body =
      '{"address":"0x1F3D3A7A9c548bE39539b39D7400302753E20591","sig":"0x22df99570b87c7a59a158e2efedd9659407c7c38cabab42aa3f8d415d1dfaf1d16ce13dcf6be95af4a8b684d54415e333e6e1d333b12d2d5f673db20fc3fe0da1b70ce11477da43ecb42a01e80147de1cff595363b5464ff67893de95dd435dc7a2e66c77e143e180ed96de5625eea28efdd411cab97c095c297d78e57e70f092f1b","hash":"0x24b4538a489032cf6f100814d361131979026983d69ea0d7f1e3e803881c108d","data":{"domain":{"name":"snapshot","version":"0.1.4"},"types":{"Vote":[{"name":"from","type":"string"},{"name":"space","type":"string"},{"name":"timestamp","type":"uint64"},{"name":"proposal","type":"string"},{"name":"choice","type":"uint32"},{"name":"reason","type":"string"},{"name":"app","type":"string"},{"name":"metadata","type":"string"}]},"message":{"from":"0x1F3D3A7A9c548bE39539b39D7400302753E20591","timestamp":1784409084,"space":"ens.eth","proposal":"0x943e585d1a4996525c5c7d229401d604ea56fe08c2c9c615c44f048ba42487b7","choice":1,"reason":"","app":"snapshot-v2","metadata":""}}}';

    expect(cidOf(new TextEncoder().encode(body))).toBe('bafkreiggjki7fx3dk7yluipfgrx6quwry373ttehwu6gv5c2oxzoim54hq');
  });
});
