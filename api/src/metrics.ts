/** Minimal Prometheus text-format registry (no dependency needed for a handful of series). */
type Labels = Record<string, string>;

const labelKey = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, v = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + v);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly fn: () => number,
  ) {}
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.fn()}`].join('\n');
  }
}

class Histogram {
  private counts: number[];
  private sum = 0;
  private count = 0;
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {
    this.counts = buckets.map(() => 0);
  }
  observe(v: number) {
    this.sum += v;
    this.count++;
    this.buckets.forEach((b, i) => {
      if (v <= b) this.counts[i]!++;
    });
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{le="${b}"} ${this.counts[i]}`));
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`, `${this.name}_sum ${this.sum}`, `${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

export class Metrics {
  readonly requests = new Counter('roomsink_http_requests_total', 'HTTP requests by route and status');
  readonly eventsWritten = new Counter('roomsink_events_written_total', 'Events stored');
  readonly rejections = new Counter('roomsink_rejections_total', 'Rejected client requests by error code');
  readonly joins = new Counter('roomsink_joins_total', 'Client joins');
  readonly cleanupDeleted = new Counter('roomsink_cleanup_rooms_deleted_total', 'Rooms deleted by the clean-up job');
  readonly writeLatency = new Histogram('roomsink_write_duration_seconds', 'Event write latency', [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5]);
  private gauges: Gauge[] = [];

  gauge(name: string, help: string, fn: () => number) {
    this.gauges.push(new Gauge(name, help, fn));
  }

  render(): string {
    const mem = process.memoryUsage();
    const parts = [
      this.requests.render(),
      this.eventsWritten.render(),
      this.rejections.render(),
      this.joins.render(),
      this.cleanupDeleted.render(),
      this.writeLatency.render(),
      ...this.gauges.map((g) => g.render()),
      `# HELP process_resident_memory_bytes Resident memory\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes ${mem.rss}`,
    ];
    return parts.join('\n') + '\n';
  }
}
