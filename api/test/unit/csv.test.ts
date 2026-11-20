import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../../src/csv.js';

describe('CSV escaping', () => {
  it('prefixes formula-like cells', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
  });
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('handles non-strings', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-3)).toBe("'-3");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(true)).toBe('true');
  });
  it('builds CRLF rows', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
  });
});
