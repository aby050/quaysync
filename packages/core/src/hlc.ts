/**
 * Hybrid logical clock.
 *
 * Timestamps are strings that sort lexicographically in causal order:
 *   <wall ms, 13 base-36 digits>-<counter, 4 base-36 digits>-<node id>
 * Ties on wall time and counter are broken by node id, so every write in
 * the system has a unique, totally ordered stamp.
 */

const MAX_DRIFT_MS = 60_000;

export interface ClockState {
  ms: number;
  counter: number;
}

export class HLC {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
    state?: ClockState,
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(node)) {
      throw new Error(`HLC node id must be alphanumeric, got "${node}"`);
    }
    if (state) {
      this.ms = state.ms;
      this.counter = state.counter;
    }
  }

  /** Stamp a local event. */
  tick(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return encode(this.ms, this.counter, this.node);
  }

  /** Advance past a stamp received from another node. */
  receive(stamp: string): void {
    const remote = decode(stamp);
    const wall = this.now();
    if (remote.ms - wall > MAX_DRIFT_MS) {
      // A peer far in the future would drag every later write with it.
      // Ignore its clock; its writes still merge by stamp order.
      return;
    }
    if (wall > this.ms && wall > remote.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (remote.ms > this.ms) {
      this.ms = remote.ms;
      this.counter = remote.counter + 1;
    } else if (remote.ms === this.ms) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else {
      this.counter++;
    }
  }

  state(): ClockState {
    return { ms: this.ms, counter: this.counter };
  }
}

export function encode(ms: number, counter: number, node: string): string {
  return `${ms.toString(36).padStart(13, '0')}-${counter.toString(36).padStart(4, '0')}-${node}`;
}

export function decode(stamp: string): { ms: number; counter: number; node: string } {
  const [ms, counter, ...rest] = stamp.split('-');
  if (!ms || !counter || rest.length === 0) throw new Error(`Bad HLC stamp "${stamp}"`);
  return { ms: parseInt(ms, 36), counter: parseInt(counter, 36), node: rest.join('-') };
}

export function randomNodeId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
