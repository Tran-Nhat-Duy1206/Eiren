import { AUTOMATION_TRIGGERS } from './contracts.js';

export type ScheduledConfig = Readonly<{ kind: 'daily'; time: string; timezone: string } | { kind: 'once'; at: string }>;
const schema = AUTOMATION_TRIGGERS[0]!.configSchema;

/** Strictly after `after`; a disabled schedule re-enabled later never replays old occurrences. */
export function nextScheduledOccurrence(config: ScheduledConfig, after: Date): Date | null {
  if (!schema.safeParse(config).success || !Number.isFinite(after.getTime())) throw new Error('Invalid scheduled configuration or reference time');
  if (config.kind === 'once') {
    const at = new Date(config.at);
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid once timestamp');
    return at.getTime() > after.getTime() ? at : null;
  }
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const local = parts(after);
  const start = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  const [hour, minute] = config.time.split(':').map(Number);
  for (let day = 0; day < 370; day++) {
    const localDay = new Date(start + day * 86_400_000);
    const year = localDay.getUTCFullYear();
    const month = localDay.getUTCMonth() + 1;
    const date = localDay.getUTCDate();
    const nominal = Date.UTC(year, month - 1, date, hour, minute);
    const candidates = new Set<number>();
    // All IANA UTC offsets lie within 24 hours. Sampling covers transitions,
    // and round-tripping rejects nonexistent wall times.
    for (let step = -4; step <= 4; step++) {
      const sample = nominal + step * 6 * 3_600_000;
      const p = parts(new Date(sample));
      const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      const candidate = nominal - (wall - sample);
      const check = parts(new Date(candidate));
      if (Number(check.year) === year && Number(check.month) === month && Number(check.day) === date &&
          Number(check.hour) === hour && Number(check.minute) === minute) candidates.add(candidate);
    }
    const earliest = [...candidates].sort((a, b) => a - b)[0];
    if (earliest !== undefined && earliest > after.getTime()) return new Date(earliest);
  }
  throw new Error('No future daily occurrence found');
}
