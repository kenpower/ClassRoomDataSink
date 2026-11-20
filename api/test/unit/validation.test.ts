import { describe, expect, it } from 'vitest';
import { checkData, parseEnvelope, SchemaCache } from '../../src/validate.js';
import { ApiError } from '../../src/errors.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).code + ':' + (e as ApiError).statusCode;
  }
  return 'ok';
};

describe('parseEnvelope', () => {
  it('accepts a single event', () => {
    const r = parseEnvelope({ app: 'quiz', data: { a: 1 }, clientT: 123, appVersion: '1.2.0' }, 50);
    expect(r.batch).toBe(false);
    expect(r.events).toHaveLength(1);
  });
  it('accepts a batch of up to 20', () => {
    const events = Array.from({ length: 20 }, () => ({ app: 'quiz', data: 1 }));
    expect(parseEnvelope({ events }, 500).events).toHaveLength(20);
    expect(code(() => parseEnvelope({ events: [...events, events[0]] }, 500))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => parseEnvelope({ events: [] }, 10))).toBe('INVALID_PAYLOAD:400');
  });
  it('enforces 2 KB single and 8 KB batch body limits', () => {
    expect(code(() => parseEnvelope({ app: 'quiz', data: 1 }, 2049))).toBe('INVALID_PAYLOAD:413');
    expect(code(() => parseEnvelope({ events: [{ app: 'quiz', data: 1 }] }, 8000))).toBe('ok');
    expect(code(() => parseEnvelope({ events: [{ app: 'quiz', data: 1 }] }, 8193))).toBe('INVALID_PAYLOAD:413');
  });
  it('rejects unexpected envelope keys including cid and t', () => {
    for (const k of ['cid', 't', 'seq', 'room', 'id']) {
      expect(code(() => parseEnvelope({ app: 'quiz', data: 1, [k]: 'x' }, 10))).toBe('INVALID_PAYLOAD:400');
    }
    expect(code(() => parseEnvelope({ events: [{ app: 'quiz', data: 1 }], app: 'x' }, 10))).toBe('INVALID_PAYLOAD:400');
  });
  it('validates app, data presence, clientT and appVersion', () => {
    expect(code(() => parseEnvelope({ app: 'Quiz', data: 1 }, 10))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => parseEnvelope({ app: 'quiz' }, 10))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => parseEnvelope({ app: 'quiz', data: 1, clientT: 1.5 }, 10))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => parseEnvelope({ app: 'quiz', data: 1, appVersion: '<script>' }, 10))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => parseEnvelope([1, 2], 10))).toBe('INVALID_PAYLOAD:400');
  });
});

describe('checkData', () => {
  it('accepts reasonable data', () => {
    expect(code(() => checkData({ answer: 'B', score: 3, ok: true, n: null, list: [1, 2, 3] }, false))).toBe('ok');
    expect(code(() => checkData(42, false))).toBe('ok');
  });
  it('limits depth to 4', () => {
    expect(code(() => checkData({ a: { b: { c: 1 } } }, false))).toBe('ok');
    expect(code(() => checkData({ a: { b: { c: { d: 1 } } } }, false))).toBe('ok');
    expect(code(() => checkData({ a: { b: { c: { d: { e: 1 } } } } }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData([[[[[1]]]]], false))).toBe('INVALID_PAYLOAD:400');
  });
  it('limits total keys/items to 50', () => {
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(code(() => checkData(fifty, false))).toBe('ok');
    expect(code(() => checkData({ ...fifty, extra: 1 }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ a: Array(30).fill(1), b: Array(30).fill(1) }, false))).toBe('INVALID_PAYLOAD:400');
  });
  it('restricts key names and rejects prototype keys', () => {
    expect(code(() => checkData({ 'bad-key': 1 }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ ['x'.repeat(41)]: 1 }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData(JSON.parse('{"__proto__": {"admin": true}}'), false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ constructor: 1 }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ a: { prototype: 1 } }, false))).toBe('INVALID_PAYLOAD:400');
  });
  it('requires finite numbers', () => {
    expect(code(() => checkData({ a: Infinity }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ a: NaN }, false))).toBe('INVALID_PAYLOAD:400');
  });
  it('limits strings to 40 chars, or 200 with allowFreeText', () => {
    expect(code(() => checkData({ s: 'x'.repeat(40) }, false))).toBe('ok');
    expect(code(() => checkData({ s: 'x'.repeat(41) }, false))).toBe('INVALID_PAYLOAD:400');
    expect(code(() => checkData({ s: 'x'.repeat(200) }, true))).toBe('ok');
    expect(code(() => checkData({ s: 'x'.repeat(201) }, true))).toBe('INVALID_PAYLOAD:400');
    // counts code points, not UTF-16 units
    expect(code(() => checkData({ s: '😀'.repeat(40) }, false))).toBe('ok');
  });
});

describe('SchemaCache', () => {
  const schema = { type: 'object', properties: { answer: { enum: ['A', 'B'] } }, required: ['answer'], additionalProperties: false };
  it('validates and caches compiled schemas', () => {
    const c = new SchemaCache();
    expect(code(() => c.validate(schema, { answer: 'A' }))).toBe('ok');
    expect(code(() => c.validate(schema, { answer: 'C' }))).toBe('SCHEMA_FAILED:422');
    expect(c.compile(schema)).toBe(c.compile({ ...schema }));
  });
  it('uses strict mode and rejects invalid schemas', () => {
    const c = new SchemaCache();
    expect(code(() => c.compile({ type: 'object', unknownKeyword: true }))).toBe('INVALID_PAYLOAD:400');
  });
  it('does not echo payload values in errors', () => {
    const c = new SchemaCache();
    try {
      c.validate(schema, { answer: '<script>alert(1)</script>' });
    } catch (e) {
      expect((e as Error).message).not.toContain('script');
    }
  });
});
