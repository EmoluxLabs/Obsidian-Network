// @vitest-environment jsdom
/**
 * The strip across the top of every page. It says which network this is, that the chain is active and how tall it is, and
 * it says "NODE UNREACHABLE" only when the chain really cannot be read. It shows no peer count and no finality figure.
 */
import { describe, expect, it } from 'vitest';
import type { ChainStatus, NodeConnection, ObsidianClient } from '../web/src/lib/client.js';
import { renderNodeBanner } from '../web/src/lib/node-banner.js';

const connection = (over: Partial<NodeConnection> = {}): NodeConnection => ({ network: 'mainnet', live: true, consensusHeight: 120, genesisMismatch: false, ...over });
const status = { height: 118, networkId: 'obsidian-mainnet-1', chainId: 7777 } as unknown as ChainStatus;

async function draw(nodes: () => Promise<NodeConnection>, chain: () => Promise<ChainStatus>): Promise<string> {
  const host = document.createElement('div');
  await renderNodeBanner(host, { nodes, status: chain } as unknown as ObsidianClient);
  return host.textContent ?? '';
}

describe('the status strip', () => {
  it('says ACTIVE and MAINNET with the height when the chain answers', async () => {
    const text = await draw(async () => connection(), async () => status);
    expect(text).toContain('ACTIVE');
    expect(text).toContain('MAINNET');
    expect(text).toContain('height 118');
    expect(text).toContain('network height 120');
    expect(text).not.toContain('UNREACHABLE');
  });

  it('shows no peer count and no finality figure', async () => {
    const text = await draw(async () => connection(), async () => ({ ...status, peers: 3, finalizedHeight: 90 }) as unknown as ChainStatus);
    expect(text).not.toMatch(/peer|finaliz|finality/i);
  });

  it('still says ACTIVE and MAINNET when only the connection summary fails', async () => {
    const text = await draw(async () => { throw new Error('summary refused'); }, async () => status);
    expect(text).toContain('ACTIVE');
    expect(text).toContain('MAINNET');
    expect(text).toContain('height 118');
    expect(text).not.toContain('UNREACHABLE');
  });

  it('still says ACTIVE when only the status read fails', async () => {
    const text = await draw(async () => connection(), async () => { throw new Error('status refused'); });
    expect(text).toContain('ACTIVE');
    expect(text).toContain('MAINNET');
    expect(text).not.toContain('UNREACHABLE');
  });

  it('says NO NODES when the interface reports it cannot reach a node', async () => {
    const text = await draw(async () => connection({ live: false }), async () => status);
    expect(text).toContain('NO NODES');
    expect(text).not.toContain('ACTIVE');
  });

  it('says NODE UNREACHABLE only when neither answer arrives, and says why', async () => {
    const text = await draw(async () => { throw new Error('the interface could not check its connection to the chain (HTTP 502)'); }, async () => { throw new Error('request failed (502)'); });
    expect(text).toContain('NODE UNREACHABLE');
    expect(text).toContain('request failed (502)');
  });
});
