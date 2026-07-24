// Lightweight local semantic similarity using trigram Jaccard.
// Zero dependencies. ~5ms on CPU. Inspired by Semantic Router's signal-decision
// architecture: we keep the "extract signal → threshold → decide" flow, but
// replace the embedding model with a deterministic n-gram similarity check
// against a curated set of task exemplars.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import type { Session } from './session.js';
import { logger } from './logger.js';
// Node 24 requires import attributes for JSON, but tsconfig module=Node16 doesn't support them.
// Use readFileSync as a portable workaround.
const capabilitiesData = JSON.parse(
  readFileSync(new URL('./data/model-capabilities.json', import.meta.url), 'utf-8'),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticRule {
  label: string;
  /** Exemplar phrases. Message similar to any → match. */
  exemplars: string[];
  /** Jaccard similarity threshold (0..1). Default 0.28. */
  threshold?: number;
  model: string;
}

export type RoutingMode = 'intelligence' | 'balance' | 'cost';

export interface RoutingConfig {
  models: {
    fast: string;
    strong: string;
  };
  /**
   * Routing mode — the user's preferred point on the cost-quality Pareto frontier.
   *   intelligence: always use the strongest model (max quality, max cost)
   *   balance:      rule-based routing, strong only when task demands it (default)
   *   cost:         prefer fast model, upgrade only on very strong signals
   */
  mode: RoutingMode;
  /** Deterministic rules (keywords / length / images). Evaluated first. */
  rules: RoutingRule[];
  /** Semantic similarity rules. Evaluated after deterministic rules. */
  semantic?: SemanticRule[];
  /** Model ref used when no rule matches */
  fallback: string;
  /** Model used when the primary call fails with quota/auth errors (403/429/usage limit) */
  errorFallback?: string;
  /** Lock to strong model for the rest of the session once upgraded */
  sticky: boolean;
  /**
   * Cache-aware routing: prefer the same model as the previous turn to
   * maximise prompt-cache hit rate (saves up to 90% input token cost on
   * Anthropic/OpenAI). Only applies when the routing signal is borderline.
   */
  cacheAware: boolean;
}

export interface RoutingRule {
  label: string;
  when: {
    keywords?: string[];
    minLength?: number;
    hasImages?: boolean;
  };
  model: string;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RoutingConfig = {
  models: {
    fast: 'potluck/fast',
    strong: 'potluck/code',
  },
  mode: 'balance',
  cacheAware: true,
  rules: [
    { label: 'has images',           when: { hasImages: true },             model: 'strong' },
    { label: 'long message',         when: { minLength: 60 },               model: 'strong' },
    { label: 'task keywords',        when: { keywords: [
      '修复', 'bug', '报错', '错误', '异常', '代码', '写个', '写一个',
      '帮我写', '实现', '开发', '部署', '运行', '执行', '脚本', '文件',
      '目录', '日志', '安装', '配置', '分析', '翻译', '总结', '搜索',
      '查一下', '帮我看', '优化', '重构', '审查',
      'code', 'fix', 'error', 'run', 'build', 'deploy', 'script',
      'file', 'folder', 'implement', 'write',
      'analyz', 'translat', 'summari', 'search', 'review', 'refactor',
      'install', 'config',
    ] },                               model: 'strong' },
  ],
  semantic: [
    {
      label: 'task intent (semantic)',
      threshold: 0.18,
      model: 'strong',
      exemplars: [
        // Chinese task exemplars
        '帮我看看这个问题', '为什么这个不工作', '这个怎么解决',
        '帮我看下这段', '帮我改一下', '帮我检查',
        '能不能帮我处理', '这里出了什么问题', '帮我搞定',
        '这个报错什么意思', '怎么才能让这个跑起来',
        '你看看这个对不对', '帮我看下日志', '分析一下原因',
        '能不能优化一下', '怎么改进这个',
        // English task exemplars
        'help me debug this', 'why is this broken', 'how do i fix',
        'can you check this', 'look at this error', 'help me with code',
        'review my implementation', 'how to make this work',
        'what is wrong with this', 'help me understand',
        'can you refactor this', 'optimize this function',
      ],
    },
  ],
  fallback: 'fast',
  errorFallback: '9router/first',
  sticky: true,
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ROUTING_PATH = join(DATA_DIR, 'routing.json');

export function loadRoutingConfig(): RoutingConfig {
  if (existsSync(ROUTING_PATH)) {
    try {
      const raw = readFileSync(ROUTING_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULT_CONFIG),
        ...parsed,
        models: { ...DEFAULT_CONFIG.models, ...parsed.models },
        rules: parsed.rules ?? DEFAULT_CONFIG.rules,
        semantic: parsed.semantic ?? DEFAULT_CONFIG.semantic,
      };
    } catch (err) {
      logger.warn('Failed to parse routing.json, using defaults', { error: String(err) });
    }
  }
  return structuredClone(DEFAULT_CONFIG);
}

export function saveRoutingConfig(config: RoutingConfig): void {
  writeFileSync(ROUTING_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function writeDefaultRoutingConfig(): void {
  if (!existsSync(ROUTING_PATH)) {
    saveRoutingConfig(DEFAULT_CONFIG);
    logger.info('Wrote default routing config', { path: ROUTING_PATH });
  }
}

// ---------------------------------------------------------------------------
// Trigram similarity (zero-dependency semantic signal)
// ---------------------------------------------------------------------------

// For CJK text (Chinese/Japanese/Korean), characters carry word-level meaning,
// so bigrams + unigrams work better than 3-character sliding windows.
// For Latin text, trigrams handle morphology/typos.
// We build a mixed set of unigrams, bigrams, and (for Latin) word trigrams.

function normalize(text: string): string {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function isCjk(ch: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(ch);
}

/** Build a character/word n-gram multiset from normalized text. */
function ngrams(text: string): Map<string, number> {
  const normalized = normalize(text);
  if (normalized.length === 0) return new Map();

  const weights = new Map<string, number>();
  const add = (g: string, w: number) => {
    weights.set(g, (weights.get(g) ?? 0) + w);
  };

  // Unigrams: high weight. CJK characters get a little more weight.
  for (const ch of normalized) {
    if (ch === ' ') continue;
    add(ch, isCjk(ch) ? 1.2 : 1.0);
  }

  // Bigrams and word trigrams
  const words = normalized.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // character bigrams within word
    for (let j = 0; j <= w.length - 2; j++) {
      add(w.slice(j, j + 2), 1.0);
    }
    // word bigrams (adjacent-word pairs)
    if (i < words.length - 1) {
      add(`${w} ${words[i + 1]}`, 0.8);
    }
    // word trigrams for longer words (Latin mostly)
    if (w.length >= 3) {
      for (let j = 0; j <= w.length - 3; j++) {
        add(w.slice(j, j + 3), 0.6);
      }
    }
  }

  return weights;
}

/** Weighted Jaccard similarity between two n-gram maps: |A ∩ B| / |A ∪ B|. */
function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  let union = 0;
  const seen = new Set<string>();
  for (const [g, w] of a) {
    const wb = b.get(g) ?? 0;
    intersection += Math.min(w, wb);
    union += Math.max(w, wb);
    seen.add(g);
  }
  for (const [g, w] of b) {
    if (!seen.has(g)) union += w;
  }
  return union === 0 ? 0 : intersection / union;
}

/** Max similarity of `text` against any exemplar. */
function maxSimilarity(text: string, exemplars: string[]): number {
  const textGrams = ngrams(text);
  let best = 0;
  for (const ex of exemplars) {
    const score = weightedJaccard(textGrams, ngrams(ex));
    if (score > best) best = score;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function resolveRef(config: RoutingConfig, ref: string): string | undefined {
  if (ref === 'fast') return config.models.fast;
  if (ref === 'strong') return config.models.strong;
  return ref;
}

export interface MatchResult {
  model: string | undefined;
  rule: string;
  /** Debug: best semantic similarity score, if semantic was evaluated */
  similarity?: number;
}

/** Match input against deterministic rules. Returns first match or null. */
function matchDeterministic(
  config: RoutingConfig,
  input: { prompt: string; hasImages: boolean },
): MatchResult | null {
  for (const rule of config.rules) {
    const w = rule.when;
    if (w.hasImages !== undefined && input.hasImages !== w.hasImages) continue;
    if (w.minLength !== undefined && input.prompt.length < w.minLength) continue;
    if (w.keywords !== undefined && w.keywords.length > 0) {
      try {
        const re = new RegExp(w.keywords.map(escapeRegex).join('|'), 'i');
        if (!re.test(input.prompt)) continue;
      } catch {
        continue;
      }
    }
    return { model: resolveRef(config, rule.model), rule: rule.label };
  }
  return null;
}

/** Match input against semantic rules. Returns best match above threshold or null. */
function matchSemantic(
  config: RoutingConfig,
  input: { prompt: string; hasImages: boolean },
): MatchResult | null {
  if (!config.semantic || config.semantic.length === 0) return null;
  // Skip semantic for very short messages (trigrams noisy).
  // 5-char minimum: CJK text packs more meaning per character.
  if (input.prompt.length < 5) return null;

  let bestMatch: MatchResult | null = null;
  let bestScore = 0;

  for (const rule of config.semantic) {
    const threshold = rule.threshold ?? 0.18;
    const score = maxSimilarity(input.prompt, rule.exemplars);
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestMatch = {
        model: resolveRef(config, rule.model),
        rule: rule.label,
        similarity: score,
      };
    }
  }
  return bestMatch;
}

/** Match input against all rules. Deterministic first, then semantic, then fallback. */
export function matchRule(config: RoutingConfig, input: { prompt: string; hasImages: boolean }): MatchResult {
  // 1. Deterministic rules
  const det = matchDeterministic(config, input);
  if (det) return det;

  // 2. Semantic rules
  const sem = matchSemantic(config, input);
  if (sem) return sem;

  // 3. Fallback
  return { model: resolveRef(config, config.fallback), rule: 'fallback' };
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  model: string | undefined;
  rule: string;
  similarity?: number;
  /** Categorised intent: "code" | "fast" | "vision" | "fallback" — used to build 9Router profile name */
  routeIntent: string;
  /** True when cache-awareness overrode a borderline signal to stay on the same model */
  cacheKept?: boolean;
}

/** Complexity score for a message (0..1). Used for dynamic upgrade detection. */
function messageComplexity(prompt: string, hasImages: boolean): number {
  let score = 0;
  // Length signal (normalized: 200+ chars = max)
  score += Math.min(prompt.length / 200, 1) * 0.4;
  // Image signal
  if (hasImages) score += 0.3;
  // Code block signal
  if (/```|`[^`]+`/.test(prompt)) score += 0.2;
  // Task keyword density
  const taskWords = [
    '修复', '重构', '优化', '实现', '开发', '部署', '架构', '设计模式',
    'debug', 'refactor', 'implement', 'architect', 'optimize', 'deploy',
  ];
  const lower = prompt.toLowerCase();
  const hits = taskWords.filter(k => lower.includes(k)).length;
  score += Math.min(hits / 3, 1) * 0.1;
  return Math.min(score, 1);
}

/** Sliding window: push complexity, keep last 5, detect upward trend. */
function trackComplexity(session: Session, score: number): boolean {
  if (!session.recentComplexity) session.recentComplexity = [];
  session.recentComplexity.push(score);
  if (session.recentComplexity.length > 5) session.recentComplexity.shift();

  // Need at least 3 data points to detect a trend
  const window = session.recentComplexity;
  if (window.length < 3) return false;

  // Trend: last 3 messages all increasing AND latest is above 0.5
  const recent = window.slice(-3);
  const increasing = recent[1] > recent[0] && recent[2] > recent[1];
  return increasing && recent[2] >= 0.5;
}

/**
 * Decide which model to use for a message.
 *
 * Priority:
 *   1. session.model (/model manual override)
 *   2. mode=intelligence → always strong
 *   3. session.autoModel (sticky strong-model lock) — with de-escalate
 *      after 3 consecutive weak messages
 *   4. Dynamic upgrade: complexity trend detection
 *   5. deterministic rules (keywords / length / images)
 *   6. semantic rules (trigram similarity) — with cache-aware override
 *   7. fallback (fast model)
 *
 * mode=cost raises the bar: only deterministic rules can trigger strong.
 */
export function decideModel(
  config: RoutingConfig,
  session: Session,
  prompt: string,
  hasImages: boolean,
): RoutingDecision {
  const mode = config.mode ?? 'balance';

  // 1. /model manual override
  if (session.model) {
    session.lastRoutedModel = session.model;
    return { model: session.model, rule: 'manual', routeIntent: 'manual' };
  }

  // 2. Intelligence mode: always use the strongest model
  if (mode === 'intelligence') {
    session.lastRoutedModel = config.models.strong;
    return { model: config.models.strong, rule: 'mode:intelligence', routeIntent: 'code' };
  }

  // 3. Sticky strong-model lock — with de-escalate if user went idle/casual
  if (config.sticky && session.autoModel === config.models.strong) {
    if (isWeakMessage(prompt, hasImages)) {
      session.autoModelWeakCount = (session.autoModelWeakCount || 0) + 1;
    } else {
      session.autoModelWeakCount = 0;
    }

    if (session.autoModelWeakCount >= 3) {
      session.autoModel = undefined;
      session.autoModelWeakCount = 0;
      session.lastRoutedModel = config.models.fast;
      return { model: config.models.fast, rule: 'de-escalate', routeIntent: 'fast' };
    }

    session.lastRoutedModel = config.models.strong;
    return { model: config.models.strong, rule: 'sticky', routeIntent: 'code' };
  }

  // 4. Dynamic upgrade: detect escalating complexity trend
  const complexity = messageComplexity(prompt, hasImages);
  const escalating = trackComplexity(session, complexity);
  if (escalating && mode === 'balance') {
    session.autoModel = config.models.strong;
    session.autoModelWeakCount = 0;
    session.lastRoutedModel = config.models.strong;
    return { model: config.models.strong, rule: 'dynamic-upgrade', routeIntent: 'code' };
  }

  // 5. Deterministic rules
  const det = matchDeterministic(config, { prompt, hasImages });
  if (det) {
    const isStrong = det.model === config.models.strong;
    // In cost mode, only images and very long messages justify strong
    if (mode === 'cost' && isStrong && det.rule === 'task keywords') {
      // Downgrade keyword matches to fast in cost mode
      session.lastRoutedModel = config.models.fast;
      return { model: config.models.fast, rule: 'cost-override', routeIntent: 'fast' };
    }
    if (isStrong && config.sticky) {
      session.autoModel = config.models.strong;
      session.autoModelWeakCount = 0;
    }
    session.lastRoutedModel = det.model;
    return { model: det.model, rule: det.rule, routeIntent: isStrong ? 'code' : 'fast' };
  }

  // 6. Semantic rules — with cache-aware override for borderline matches
  const sem = matchSemantic(config, { prompt, hasImages });
  if (sem) {
    const threshold = config.semantic?.[0]?.threshold ?? 0.18;
    const isBorderline = (sem.similarity ?? 0) < threshold * 1.5;

    // Cache-aware: borderline signal + same model last turn → stay (preserve cache)
    if (config.cacheAware && isBorderline && session.lastRoutedModel) {
      const wouldSwitch = sem.model !== session.lastRoutedModel;
      if (wouldSwitch && mode === 'cost') {
        // In cost mode, borderline never upgrades
        session.lastRoutedModel = config.models.fast;
        return { model: config.models.fast, rule: 'cache-keep(cost)', routeIntent: 'fast', cacheKept: true };
      }
      if (wouldSwitch && isBorderline) {
        // Balance mode: borderline stays on last model for cache hit
        session.lastRoutedModel = session.lastRoutedModel;
        const intent = session.lastRoutedModel === config.models.strong ? 'code' : 'fast';
        return { model: session.lastRoutedModel, rule: 'cache-keep', routeIntent: intent, cacheKept: true };
      }
    }

    const isStrong = sem.model === config.models.strong;
    if (mode === 'cost' && isStrong) {
      // Cost mode: semantic alone can't upgrade
      session.lastRoutedModel = config.models.fast;
      return { model: config.models.fast, rule: 'cost-override(semantic)', routeIntent: 'fast' };
    }
    if (isStrong && config.sticky) {
      session.autoModel = config.models.strong;
      session.autoModelWeakCount = 0;
    }
    session.lastRoutedModel = sem.model;
    return { model: sem.model, rule: sem.rule, similarity: sem.similarity, routeIntent: isStrong ? 'code' : 'fast' };
  }

  // 7. Fallback
  const fallbackModel = resolveRef(config, config.fallback);
  session.lastRoutedModel = fallbackModel;
  return { model: fallbackModel, rule: 'fallback', routeIntent: 'fast' };
}

/** A "weak" message: short, no keywords, no images — likely idle/casual chatter */
function isWeakMessage(prompt: string, hasImages: boolean): boolean {
  if (hasImages) return false;
  if (prompt.length > 40) return false;
  const taskKeywords = [
    '修复', '修改', '改', '写', '代码', '跑', '运行', '测试',
    '部署', '文件', '搜索', '翻译', '分析', '检查', '看看',
    'fix', 'run', 'deploy', 'test', 'build', 'implement', 'write', 'code',
    'check', 'review', 'debug', 'error', 'help', 'how',
  ];
  const lower = prompt.toLowerCase();
  if (taskKeywords.some(k => lower.includes(k))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Capability-aware routing (static data from LMArena + public benchmarks)
// ---------------------------------------------------------------------------

export type TaskCategory = 'coding' | 'math' | 'creative' | 'instruction' | 'general';

export interface ModelCapability {
  model: string;
  quality: number;
  elo: number | null;
  speed: number | null;
  priceIn: number;
  priceOut: number;
  [key: string]: unknown;
}

export interface CategoryRecommendation {
  category: TaskCategory;
  model: string;
  quality: number;
  priceOut: number;
  reason: string;
}

const capabilities = capabilitiesData as unknown as {
  categories: Record<string, { description: string; signals: string[]; ranking: ModelCapability[] }>;
  valuePicks: Record<string, string>;
  costTiers: Record<string, { maxOut: number; models: string[] }>;
};

/**
 * Detect the task category from a prompt using keyword signals.
 * Returns the best-matching category, or 'general' if no strong signal.
 */
export function detectCategory(prompt: string): TaskCategory {
  const lower = prompt.toLowerCase();
  let best: TaskCategory = 'general';
  let bestHits = 0;

  for (const [cat, data] of Object.entries(capabilities.categories)) {
    if (cat === 'general') continue;
    const hits = data.signals.filter(s => lower.includes(s.toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = cat as TaskCategory;
    }
  }
  return best;
}

/**
 * Recommend a specific model based on task category and routing mode.
 * Uses the static capability table compiled from LMArena ELO and public benchmarks.
 *
 *   intelligence → top of ranking (max quality regardless of cost)
 *   balance      → best quality/price ratio in the top half
 *   cost         → valuePicks entry (cheapest model that still scores 90+)
 */
export function recommendModel(category: TaskCategory, mode: RoutingMode): CategoryRecommendation {
  const catData = capabilities.categories[category] ?? capabilities.categories.general;
  const ranking = catData.ranking;

  if (mode === 'intelligence') {
    const top = ranking[0];
    return { category, model: top.model, quality: top.quality, priceOut: top.priceOut, reason: 'top-ranked' };
  }

  if (mode === 'cost') {
    const pick = capabilities.valuePicks[category] ?? capabilities.valuePicks.general;
    const entry = ranking.find(r => r.model === pick) ?? ranking[ranking.length - 1];
    return { category, model: entry.model, quality: entry.quality, priceOut: entry.priceOut, reason: 'value-pick' };
  }

  // Balance: best quality per dollar in the top 60% of the ranking
  const cutoff = Math.max(3, Math.ceil(ranking.length * 0.6));
  let bestRatio = 0;
  let bestEntry = ranking[0];
  for (const entry of ranking.slice(0, cutoff)) {
    const ratio = entry.quality / Math.max(entry.priceOut, 0.5);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestEntry = entry;
    }
  }
  return { category, model: bestEntry.model, quality: bestEntry.quality, priceOut: bestEntry.priceOut, reason: 'quality-per-dollar' };
}

/** Expose raw capability data for external tools / dashboards. */
export function getCapabilityData() {
  return capabilities;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}