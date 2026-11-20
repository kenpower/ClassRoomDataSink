// k6 load test: 300 clients each sending 1 event/s for 10 minutes into one room.
//
//   ROOM=ABC234 BASE_URL=https://roomsink.example.ie k6 run deploy/k6/load.js
//
// Create and open the room first (the admin UI, or POST /api/v1/admin/rooms) with an app named "load"
// and maxEventsPerClient ≥ 700. All VUs come from one IP, like a classroom NAT, so raise IP_RATE_PER_SEC
// (e.g. 400) for the run, or put the k6 host in TRUST_PROXY_CIDRS and set SPOOF_XFF=1 to spread
// clients across fake IPs. Targets: p95 write < 150 ms, < 0.1% errors.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const ROOM = __ENV.ROOM;
const SPOOF = __ENV.SPOOF_XFF === '1';
if (!ROOM) throw new Error('Set ROOM=<code>');

const writeTime = new Trend('roomsink_write_ms', true);
const writeErrors = new Rate('roomsink_write_errors');

export const options = {
  scenarios: {
    classroom: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 300),
      duration: __ENV.DURATION || '10m',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    roomsink_write_ms: ['p(95)<150'],
    roomsink_write_errors: ['rate<0.001'],
    http_req_failed: ['rate<0.01'],
  },
};

const ipFor = (vu) => `10.${(vu >> 16) & 255}.${(vu >> 8) & 255}.${vu & 255}`;

export function setup() {
  const r = http.get(`${BASE}/api/v1/rooms/${ROOM}/config`);
  check(r, { 'room is open': (x) => x.status === 200 && x.json('status') === 'open' });
}

let token = null;
let n = 0;

export default function () {
  const headers = { 'Content-Type': 'application/json' };
  if (SPOOF) headers['X-Forwarded-For'] = ipFor(__VU);
  if (!token) {
    // Stagger joins over the first ~10 s, like a class scanning a QR code.
    sleep(Math.random() * 10);
    const j = http.post(`${BASE}/api/v1/rooms/${ROOM}/join`, '{}', { headers });
    if (!check(j, { joined: (x) => x.status === 201 || x.status === 200 })) {
      sleep(Number(j.headers['Retry-After'] || 1));
      return;
    }
    token = j.json('token');
  }
  const started = Date.now();
  const res = http.post(
    `${BASE}/api/v1/rooms/${ROOM}/events`,
    JSON.stringify({ app: 'load', data: { n: n, choice: ['A', 'B', 'C', 'D'][n % 4], rt: Math.round(Math.random() * 5000) }, clientT: Date.now() }),
    { headers: { ...headers, Authorization: `Bearer ${token}`, 'Idempotency-Key': `${__VU}-${__ITER}` }, tags: { name: 'write' } },
  );
  n++;
  writeTime.add(res.timings.duration);
  writeErrors.add(res.status !== 202);
  check(res, { 'write 202': (x) => x.status === 202 });
  sleep(Math.max(0, 1 - (Date.now() - started) / 1000));
}
