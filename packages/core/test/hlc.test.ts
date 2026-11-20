import { describe, expect, it } from 'vitest';
import { HLC, decodeHLC } from '@quaysync/core';

describe('HLC', () => {
  it('is monotonic when the wall clock stalls or goes back', () => {
    let t = 1000;
    const c = new HLC('a', () => t);
    const s1 = c.tick();
    t = 500;
    const s2 = c.tick();
    const s3 = c.tick();
    expect(s1 < s2 && s2 < s3).toBe(true);
  });
  it('moves past a remote stamp', () => {
    const a = new HLC('a', () => 1000);
    const b = new HLC('b', () => 900);
    const remote = a.tick();
    b.receive(remote);
    expect(b.tick() > remote).toBe(true);
  });
  it('ignores a peer clock far in the future', () => {
    const far = new HLC('a', () => 10_000_000).tick();
    const b = new HLC('b', () => 1000);
    b.receive(far);
    expect(decodeHLC(b.tick()).ms).toBe(1000);
  });
  it('rejects node ids that would break parsing', () => {
    expect(() => new HLC('a-b')).toThrow();
  });
});
