import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  // Handle embedded IPv4 (::ffff:1.2.3.4)
  let addr = ip;
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]!);
    addr = addr.replace(v4[1]!, `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`);
  }
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  const parts = [...h, ...fill, ...t];
  return parts.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}

/** Normalise IPv4-mapped IPv6 to plain IPv4. */
export function normaliseIp(ip: string): string {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1]! : ip;
}

export interface Cidr {
  v: 4 | 6;
  base: bigint;
  bits: number;
}

export function parseCidr(s: string): Cidr {
  const [addr, len] = s.split('/') as [string, string | undefined];
  const ip = normaliseIp(addr);
  const v = isIP(ip);
  if (v !== 4 && v !== 6) throw new Error(`Invalid CIDR: ${s}`);
  const max = v === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`Invalid CIDR: ${s}`);
  const n = v === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  const shift = BigInt(max - bits);
  return { v, base: (n >> shift) << shift, bits };
}

export function ipInCidrs(ipRaw: string, cidrs: Cidr[]): boolean {
  const ip = normaliseIp(ipRaw);
  const v = isIP(ip);
  if (!v) return false;
  const n = v === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  return cidrs.some((c) => {
    if (c.v !== v) return false;
    const shift = BigInt((v === 4 ? 32 : 128) - c.bits);
    return (n >> shift) << shift === c.base;
  });
}

/** Hash IPs for logs with a salt that rotates daily, so logs never contain a usable IP. */
export class IpHasher {
  private day = '';
  private salt = Buffer.alloc(0);
  hash(ip: string): string {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.salt = randomBytes(16);
    }
    return createHash('sha256').update(this.salt).update(ip).digest('hex').slice(0, 16);
  }
}
