import { pathToFileURL } from 'node:url';
import { parseRecoveryManifest } from '../core/recovery/manifest.js';
import { readPrivateManifestFile, writePrivateJsonFile } from '../core/recovery/io.js';
import { blockedRecoveryReport, verifyRecovery, type RecoveryReport } from '../core/recovery/verify.js';

/** Verification never loads .env and never imports the bot/application bootstrap. */
export async function runRecoveryVerify(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let report: RecoveryReport;
  if (args.length || !env.RECOVERY_MANIFEST_PATH) report = blockedRecoveryReport('MANIFEST_INVALID');
  else {
    try {
      const manifest = parseRecoveryManifest(await readPrivateManifestFile(env.RECOVERY_MANIFEST_PATH));
      report = await verifyRecovery(env.RECOVERY_DATABASE_URL || '', manifest, { confirmation: env.RECOVERY_VERIFY_CONFIRM, sourceDatabaseUrl: env.DATABASE_URL });
    } catch { report = blockedRecoveryReport('MANIFEST_INVALID'); }
  }
  if (env.RECOVERY_REPORT_PATH) {
    try { await writePrivateJsonFile(env.RECOVERY_REPORT_PATH, report); }
    catch { report.status = 'BLOCKED'; report.counts.UNAVAILABLE++; }
  }
  // No paths, URLs, raw IDs, exception messages, stack traces, or private payloads.
  console.log(JSON.stringify(report));
  return report.status === 'PASS' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runRecoveryVerify();
