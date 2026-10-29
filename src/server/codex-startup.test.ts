import { expect, test } from 'bun:test';
import { serializeCodexRuntimeStart } from './codex-app-server';

test('concurrent branches share one profile initialization lane, while different profiles stay independent', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = serializeCodexRuntimeStart('new-profile', async () => { order.push('first'); await blocked; });
  const second = serializeCodexRuntimeStart('new-profile', async () => { order.push('second'); return 'ready'; });
  await serializeCodexRuntimeStart('other-profile', async () => { order.push('other'); });
  expect(order).toEqual(['first', 'other']);
  release();
  await first;
  expect(await second).toBe('ready');
  expect(order).toEqual(['first', 'other', 'second']);
});

test('a failed initialization releases the profile for a later branch', async () => {
  const first = serializeCodexRuntimeStart('failed-profile', async () => { throw new Error('failed'); });
  const second = serializeCodexRuntimeStart('failed-profile', async () => 'recovered');
  await expect(first).rejects.toThrow('failed');
  expect(await second).toBe('recovered');
});
