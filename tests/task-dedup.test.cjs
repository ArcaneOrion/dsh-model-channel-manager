const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('./helpers/profile.cjs');

test('并发相同任务仅预留和执行一次，重复请求返回同一结果', async () => {
  const { TaskRegistry } = await import('../src/channel-state.js');
  let count = 0;
  const tasks = new TaskRegistry();
  const request = { nonce: 'random-id', provider: 'test', model: 'test' };
  const run = async () => { count++; return { text: 'one result' }; };
  await Promise.all(Array.from({ length: 12 }, () => tasks.submit('test', request, run)));
  await waitFor(() => tasks.get('random-id').status === 'ok');
  assert.equal(count, 1);
  assert.equal((await tasks.submit('test', request, run)).text, 'one result');
  await tasks.close();
});

test('数字与字符串 nonce 归一化且有长度/安全整数边界', async () => {
  const { requests } = await import('../src/channel-state.js');
  assert.equal(requests.task.parse({ id: 42 }).id, '42');
  assert.equal(requests.task.parse({ id: '42' }).id, '42');
  assert.equal(requests.task.safeParse({ id: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(requests.task.safeParse({ id: 'x'.repeat(129) }).success, false);
});
