import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleStreamLine, type StreamParserState } from '../claude/provider.js';

function freshState(): StreamParserState {
  return { sessionId: '', textParts: [], trackingSkill: false, skillInputAccum: '' };
}

test('handleStreamLine: session.resume_hint 设置 sessionId', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_abc-123',
      command: 'kimi -r session_abc-123',
    }),
    state,
    {},
  );
  assert.equal(state.sessionId, 'session_abc-123');
});

test('handleStreamLine: assistant 文本触发 onText 并以 end_turn 收尾', () => {
  const state = freshState();
  const texts: string[] = [];
  const turnEnds: string[] = [];
  handleStreamLine(
    JSON.stringify({ role: 'assistant', content: '回复内容' }),
    state,
    { onText: (t) => texts.push(t), onTurnEnd: (r) => turnEnds.push(r) },
  );
  assert.deepEqual(state.textParts, ['回复内容']);
  assert.deepEqual(texts, ['回复内容']);
  assert.deepEqual(turnEnds, ['end_turn']);
});

test('handleStreamLine: tool_calls 推送进度并以 tool_use 收尾', () => {
  const state = freshState();
  const texts: string[] = [];
  const turnEnds: string[] = [];
  handleStreamLine(
    JSON.stringify({
      role: 'assistant',
      tool_calls: [
        { type: 'function', id: 'tool_1', function: { name: 'Bash', arguments: '{}' } },
      ],
    }),
    state,
    { onText: (t) => texts.push(t), onTurnEnd: (r) => turnEnds.push(r) },
  );
  assert.deepEqual(texts, ['\n正在调用 Bash\n\n']);
  assert.deepEqual(turnEnds, ['tool_use']);
  assert.deepEqual(state.textParts, []);
});

test('handleStreamLine: 同一行 content + tool_calls 以 tool_use 收尾', () => {
  const state = freshState();
  const turnEnds: string[] = [];
  handleStreamLine(
    JSON.stringify({
      role: 'assistant',
      content: '先看一下文件',
      tool_calls: [
        { type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{}' } },
      ],
    }),
    state,
    { onTurnEnd: (r) => turnEnds.push(r) },
  );
  assert.deepEqual(state.textParts, ['先看一下文件']);
  assert.deepEqual(turnEnds, ['tool_use']);
});

test('handleStreamLine: tool 角色和其它 meta 类型静默忽略', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({ role: 'tool', tool_call_id: 'tool_1', content: 'output' }),
    state,
    {},
  );
  handleStreamLine(
    JSON.stringify({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 1 }),
    state,
    {},
  );
  assert.deepEqual(state.textParts, []);
  assert.equal(state.sessionId, '');
});

test('handleStreamLine: 空行和非法 JSON 静默跳过', () => {
  const state = freshState();
  handleStreamLine('', state, {});
  handleStreamLine('not json', state, {});
  handleStreamLine('   ', state, {});
  assert.deepEqual(state.textParts, []);
});
