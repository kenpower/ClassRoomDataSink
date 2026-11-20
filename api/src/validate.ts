import { Ajv, type ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';
import { APP_NAME_RE } from './codes.js';

export const SINGLE_BODY_LIMIT = 2 * 1024;
export const BATCH_BODY_LIMIT = 8 * 1024;
export const MAX_BATCH = 20;
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ENVELOPE_KEYS = new Set(['app', 'data', 'clientT', 'appVersion']);

export interface EventInput {
  app: string;
  data: unknown;
  clientT?: number;
  appVersion?: string;
}

const invalid = (msg: string) => new ApiError('INVALID_PAYLOAD', msg);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkEnvelope(e: unknown, where: string): EventInput {
  if (!isPlainObject(e)) throw invalid(`${where} must be an object`);
  for (const k of Object.keys(e)) if (!ENVELOPE_KEYS.has(k)) throw invalid(`${where} has an unexpected key`);
  if (typeof e.app !== 'string' || !APP_NAME_RE.test(e.app)) throw invalid(`${where}.app is invalid`);
  if (!('data' in e)) throw invalid(`${where}.data is required`);
  if (e.clientT !== undefined && (typeof e.clientT !== 'number' || !Number.isSafeInteger(e.clientT)))
    throw invalid(`${where}.clientT must be an integer`);
  if (e.appVersion !== undefined && (typeof e.appVersion !== 'string' || !/^[\w.+-]{1,20}$/.test(e.appVersion)))
    throw invalid(`${where}.appVersion is invalid`);
  return e as unknown as EventInput;
}

/**
 * Step 1 (size) and 2 (envelope) of the validation pipeline.
 * Returns the list of events and whether the body was a batch.
 */
export function parseEnvelope(body: unknown, rawSize: number): { events: EventInput[]; batch: boolean } {
  if (!isPlainObject(body)) throw invalid('Body must be a JSON object');
  if ('events' in body) {
    if (rawSize > BATCH_BODY_LIMIT) throw new ApiError('INVALID_PAYLOAD', 'Body too large', { status: 413 });
    if (Object.keys(body).length !== 1) throw invalid('Batch body must only contain "events"');
    const list = body.events;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BATCH) throw invalid(`events must be an array of 1-${MAX_BATCH}`);
    return { events: list.map((e, i) => checkEnvelope(e, `events[${i}]`)), batch: true };
  }
  if (rawSize > SINGLE_BODY_LIMIT) throw new ApiError('INVALID_PAYLOAD', 'Body too large', { status: 413 });
  return { events: [checkEnvelope(body, 'body')], batch: false };
}

/** Step 4: structural limits on `data`. */
export function checkData(data: unknown, allowFreeText: boolean): void {
  const maxStr = allowFreeText ? 200 : 40;
  let count = 0;
  const walk = (v: unknown, depth: number): void => {
    if (v !== null && typeof v === 'object' && depth > 4) throw invalid('data is nested too deeply');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw invalid('data contains a non-finite number');
      return;
    }
    if (typeof v === 'string') {
      if ([...v].length > maxStr) throw invalid(`data strings must be at most ${maxStr} characters`);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (++count > 50) throw invalid('data has too many keys or items');
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k) || !KEY_RE.test(k)) throw invalid('data contains an invalid key');
        if (++count > 50) throw invalid('data has too many keys or items');
        walk((v as Record<string, unknown>)[k], depth + 1);
      }
      return;
    }
    throw invalid('data contains an unsupported value');
  };
  // depth counts containers: the top-level value is depth 1.
  walk(data, 1);
}

/** Compiled Ajv validators keyed by schema hash. */
export class SchemaCache {
  private readonly ajv = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true });
  private readonly cache = new Map<string, ValidateFunction>();

  private key(schema: unknown) {
    return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  }

  /** Throws if the schema itself is invalid (used when staff save an app). */
  compile(schema: unknown): ValidateFunction {
    const k = this.key(schema);
    let fn = this.cache.get(k);
    if (!fn) {
      if (!isPlainObject(schema) && typeof schema !== 'boolean') throw invalid('schema must be an object');
      try {
        fn = this.ajv.compile(schema as object);
      } catch (err) {
        throw invalid(`schema is not valid: ${(err as Error).message.slice(0, 200)}`);
      }
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(k, fn);
    }
    return fn;
  }

  validate(schema: unknown, data: unknown): void {
    const fn = this.compile(schema);
    if (!fn(data)) {
      const e = fn.errors?.[0];
      // Report the location and rule only; never echo the payload back.
      throw new ApiError('SCHEMA_FAILED', `data failed schema at ${e?.instancePath || '/'}: ${e?.keyword ?? 'invalid'}`);
    }
  }
}

export function jsonByteLength(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}
