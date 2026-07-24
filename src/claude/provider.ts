import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when an assistant turn ends, with its stop_reason
   *  ('tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | ...).
   *  Use to decide whether the turn's text is interstitial or final answer. */
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = join(tmpdir(), 'wechat-kimi-code');

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Stream parser (extracted for testability)
// ---------------------------------------------------------------------------

export interface StreamParserState {
  sessionId: string;
  textParts: string[];
  errorMessage?: string;
  trackingSkill: boolean;
  skillInputAccum: string;
}

export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onTurnEnd?: (stopReason: string) => void;
}

export function handleStreamLine(
  line: string,
  state: StreamParserState,
  callbacks: StreamParserCallbacks,
): void {
  if (!line.trim()) return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  // kimi -p --output-format stream-json emits NDJSON lines like:
  //   {"role":"assistant","content":"..."}
  //   {"role":"assistant","tool_calls":[{"type":"function","function":{"name":"Bash","arguments":"..."}}]}
  //   {"role":"tool","tool_call_id":"...","content":"..."}
  //   {"role":"meta","type":"session.resume_hint","session_id":"session_...",...}
  switch (obj.role) {
    case 'assistant': {
      const text = typeof obj.content === 'string' ? obj.content : '';
      const toolCalls: any[] = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      if (text) {
        state.textParts.push(text);
        if (callbacks.onText) Promise.resolve(callbacks.onText(text)).catch(() => {});
      }
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        if (name && callbacks.onText) {
          Promise.resolve(callbacks.onText(`\n正在调用 ${name}\n\n`)).catch(() => {});
        }
      }
      if ((text || toolCalls.length) && callbacks.onTurnEnd) {
        const stopReason = toolCalls.length ? 'tool_use' : 'end_turn';
        Promise.resolve(callbacks.onTurnEnd(stopReason)).catch(() => {});
      }
      break;
    }
    case 'meta': {
      if (obj.type === 'session.resume_hint' && obj.session_id) {
        state.sessionId = obj.session_id;
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
  } = options;

  logger.info("Starting Kimi CLI query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Build the prompt. kimi -p takes the prompt as an argument (no stdin),
  // has no --append-system-prompt flag, so prepend it to the prompt instead.
  const tempImagePaths = images?.length ? saveImageTemp(images) : [];
  let fullPrompt = prompt;
  if (systemPrompt) fullPrompt = `${systemPrompt}\n\n${fullPrompt}`;
  if (tempImagePaths.length > 0) {
    const imageLines = tempImagePaths.map(p => `\n![image](file://${p})`).join('');
    fullPrompt += imageLines;
  }

  // kimi in prompt mode auto-approves tool calls, no extra flag needed.
  const args: string[] = ['-p', fullPrompt, '--output-format', 'stream-json'];

  if (resume) args.push('-r', resume);
  if (model) args.push('-m', model);

  // Accumulators
  let child: ChildProcess | undefined;
  let settled = false;

  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      resolve(result);
    };

    try {
      child = spawn('kimi', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn kimi: ${msg}` });
      return;
    }

    // Timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Kimi CLI query timed out, killing process');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId: parserState.sessionId,
        error: partialText ? undefined : 'Kimi query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Kimi CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({ text: partialText, sessionId: parserState.sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse NDJSON from stdout (logic in handleStreamLine for testability)
    const parserState: StreamParserState = {
      sessionId: '',
      textParts: [],
      trackingSkill: false,
      skillInputAccum: '',
    };
    const parserCallbacks: StreamParserCallbacks = { onText, onTurnEnd };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      handleStreamLine(line, parserState, parserCallbacks);
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !parserState.textParts.length && !parserState.errorMessage) {
        const stderr = stderrParts.join('').trim();
        parserState.errorMessage = stderr || `kimi exited with code ${code}`;
        logger.error('Kimi CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = parserState.textParts.join('\n').trim();

      if (!fullText && !parserState.errorMessage) {
        parserState.errorMessage = 'Kimi returned an empty response.';
      }

      logger.info("Kimi CLI query completed", {
        sessionId: parserState.sessionId,
        textLength: fullText.length,
        hasError: !!parserState.errorMessage,
      });

      finish({
        text: fullText,
        sessionId: parserState.sessionId,
        error: parserState.errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId: parserState.sessionId, error: `Failed to spawn kimi: ${err.message}` });
    });
  });
}
