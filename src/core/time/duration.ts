import { AppError } from '../errors/errors.js';

/** Parses compact durations such as 30m, 2h, or 1d into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d{1,4})(m|h|d)$/i.exec(value.trim());
  if (!match) throw new AppError('VALIDATION', 'Use a duration such as 30m, 2h, or 1d.');
  const seconds = Number(match[1]) * ({ m: 60, h: 3600, d: 86400 }[match[2]!.toLowerCase()] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 60) throw new AppError('VALIDATION', 'Invalid duration.');
  return seconds;
}
