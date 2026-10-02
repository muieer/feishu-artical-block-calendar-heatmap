import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionStorage } from '../src/interaction.mjs';

function fixture(ids = ['instance']) {
  const calls = { reads: 0, writes: [], blocks: 0 };
  const api = {
    getActiveBlock: async () => ({ data: { component_id: ids[Math.min(calls.blocks++, ids.length - 1)] } }),
    Interaction: {
      getData: async () => { calls.reads += 1; return { preserved: true }; },
      setData: async changeset => { calls.writes.push(changeset); return {}; },
    },
  };
  return { api, calls, storage: createInteractionStorage(api) };
}

test('component_id 为空也通过真实 Interaction API 读取和写入', async () => {
  const { storage, calls } = fixture(['']);
  assert.deepEqual(await storage.readData(), { preserved: true });
  await storage.writeData('key', { saved: true });
  assert.equal(calls.reads, 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.blocks, 0);
});

test('块元数据接口不可用不会阻止可用的 Interaction', async () => {
  const { storage, api } = fixture();
  api.getActiveBlock = async () => { throw new Error('metadata unavailable'); };
  assert.deepEqual(await storage.readData(), { preserved: true });
  await storage.writeData('key', {});
});

test('读取超时保留原错误，不伪造空 Interaction 数据', async () => {
  const { storage, api, calls } = fixture();
  const cause = new Error('API[Interaction.getData] call timeout');
  api.Interaction.getData = async () => { throw cause; };
  await assert.rejects(storage.readData(), error => error.code === 'INTERACTION_READ_TIMEOUT' && error.cause === cause);
  assert.deepEqual(calls.writes, []);
});

test('无效返回值不能当作首次启用；恢复正常后可以重试', async () => {
  const { storage, api } = fixture();
  api.Interaction.getData = async () => null;
  await assert.rejects(storage.readData(), /格式无效/);
  api.Interaction.getData = async () => ({});
  assert.deepEqual(await storage.readData(), {});
});

test('存储只替换指定路径，保留其它数据', async () => {
  const { storage, calls } = fixture();
  await storage.writeData('revisionHeatmapV1', { version: 1 });
  assert.deepEqual(calls.writes, [{ type: 'replace', data: { path: ['revisionHeatmapV1'], value: { version: 1 } } }]);
});
