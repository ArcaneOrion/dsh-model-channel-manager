const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('./helpers/profile.cjs');

test('终态持久化失败仍保留真实结果并显式返回存储错误', async () => {
  const { TaskRegistry } = await import('../src/channel-state.js');
  let writes = 0;
  const tasks = new TaskRegistry({ persist: async () => { if (++writes > 1) throw new Error('disk full'); } });
  await tasks.submit('test', { nonce: 'result' }, async () => ({ text: 'answer' }));
  await waitFor(() => tasks.get('result').persistenceError);
  assert.equal(tasks.get('result').status, 'ok');
  assert.equal(tasks.get('result').text, 'answer');
  assert.match(tasks.get('result').persistenceError, /disk full/);
  await tasks.close();
});

test('恢复时已有终态不可退回running，未完成任务标记为中断', async () => {
  const { TaskRegistry } = await import('../src/channel-state.js');
  const tasks = new TaskRegistry();
  tasks.restore([{ id: 'finished', status: 'ok', text: 'saved' }, { id: 'interrupted', status: 'running', startedAt: 1 }]);
  assert.equal(tasks.get('finished').status, 'ok');
  assert.equal(tasks.get('interrupted').code, 'ABORTED');
  assert.equal(tasks.running.size, 0);
  await tasks.close();
});
