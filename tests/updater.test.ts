// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { compareVersions } from '../src/main/updater';

describe('compareVersions', () => {
  it('returns >0 when remote is newer (patch)', () => {
    expect(compareVersions('0.4.0', '0.3.0')).toBeGreaterThan(0);
  });
  it('returns 0 when equal', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  });
  it('returns <0 when remote is older', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
  });
  it('compares numerically not lexically (1.0.0 > 0.9.9)', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
  it('handles two-digit segments (0.10.0 > 0.9.0)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });
  it('returns null for invalid remote version (abc)', () => {
    expect(compareVersions('abc', '0.3.0')).toBeNull();
  });
  it('returns null for invalid remote version (1.2)', () => {
    expect(compareVersions('1.2', '0.3.0')).toBeNull();
  });
  it('returns null for invalid remote version (1.2.3.4)', () => {
    expect(compareVersions('1.2.3.4', '0.3.0')).toBeNull();
  });
});
