import { describe, expect, it } from 'vitest';
import { formatTime } from '~/utils';

describe('formatTime', () => {
  it('returns 00:00 for zero or negative durations', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(-500)).toBe('00:00');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(65_000)).toBe('01:05');
  });

  it('includes hours once the duration is an hour or more', () => {
    expect(formatTime(3_661_000)).toBe('01:01:01');
  });
});
