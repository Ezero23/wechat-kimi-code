import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, type RoutingConfig } from '../router.js';

const TEST_CONFIG: RoutingConfig = {
  models: { fast: 'fast-model', strong: 'strong-model' },
  mode: 'balance',
  cacheAware: true,
  rules: [
    { label: 'has images', when: { hasImages: true }, model: 'strong' },
    { label: 'long message', when: { minLength: 60 }, model: 'strong' },
    { label: 'task keywords', when: { keywords: [
      '修复', 'bug', '错误', 'fix', 'implement', 'code',
    ] }, model: 'strong' },
  ],
  semantic: [
    {
      label: 'task intent (semantic)',
      threshold: 0.18,
      model: 'strong',
      exemplars: [
        '帮我看下这个', '帮我检查一下', '这个出了什么问题',
        '怎么才能让这个跑起来', '帮我改一下',
        '为什么这个不工作', '帮我看下日志', '帮我看看这个',
        'help me debug this', 'how do i fix this',
        'can you check this for me',
      ],
    },
  ],
  fallback: 'fast',
  sticky: true,
};

describe('router', () => {
  // ── Deterministic rules ──

  it('routes to strong for images', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '你好', hasImages: true });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'has images');
  });

  it('routes to strong for long messages', () => {
    const r = matchRule(TEST_CONFIG, { prompt: 'a'.repeat(61), hasImages: false });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'long message');
  });

  it('routes to strong for task keywords (Chinese)', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '帮我修复这个bug', hasImages: false });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'task keywords');
  });

  it('routes to strong for English task keywords', () => {
    const r = matchRule(TEST_CONFIG, { prompt: 'can you implement this', hasImages: false });
    assert.equal(r.model, 'strong-model');
  });

  it('routes single keyword', () => {
    const r = matchRule(TEST_CONFIG, { prompt: 'fix', hasImages: false });
    assert.equal(r.model, 'strong-model');
  });

  // ── Semantic rules ──

  it('routes via semantic for task intent without keywords', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '帮我检查一下', hasImages: false });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'task intent (semantic)');
    assert.ok(typeof r.similarity === 'number');
  });

  it('routes via semantic for short task messages (5+ chars)', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '帮我看下这个', hasImages: false });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'task intent (semantic)');
  });

  it('catches "为什么" patterns semantically', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '为什么这个不工作', hasImages: false });
    assert.equal(r.model, 'strong-model');
    assert.equal(r.rule, 'task intent (semantic)');
  });

  // ── Fallback ──

  it('falls back for casual short text', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '今天天气真不错', hasImages: false });
    assert.equal(r.model, 'fast-model');
    assert.equal(r.rule, 'fallback');
  });

  it('semantic does not fire for < 5 chars', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '你好', hasImages: false });
    assert.equal(r.model, 'fast-model');
    assert.equal(r.rule, 'fallback');
  });

  it('casual messages not matched as task', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '今天吃了吗', hasImages: false });
    assert.equal(r.model, 'fast-model');
  });

  it('short tasks routed via semantic when 5 chars and matches exemplar', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '帮我改一下', hasImages: false });
    assert.equal(r.model, 'strong-model');
  });

  it('different casual >5 chars also not matched', () => {
    const r = matchRule(TEST_CONFIG, { prompt: '下午好呀今天天气不错', hasImages: false });
    assert.equal(r.model, 'fast-model');
  });
});
