import { pathToFileURL } from 'node:url';
import { exportRecoveryManifest } from '../core/recovery/verify.js';
import { writePrivateJsonFile } from '../core/recovery/io.js';
import { RecoveryError } from '../core/recovery/manifest.js';

/** Explicit operator environment only. No dotenv, application config, bot bootstrap, or Discord. */
export async function runRecoveryExport(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let stage: 'configuration' | 'export' | 'file' = 'configuration';
  try {
    let output = env.RECOVERY_MANIFEST_PATH;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new RecoveryError('UNAVAILABLE');
      output = args[1];
    }
    if (!env.DATABASE_URL || !output) throw new RecoveryError('UNAVAILABLE');
    stage = 'export';
    const manifest = await exportRecoveryManifest(env.DATABASE_URL);
    stage = 'file'; await writePrivateJsonFile(output, manifest);
    console.log(JSON.stringify({ status: 'PASS', stage: 'complete', generatedAt: manifest.generatedAt, migrationCount: manifest.migrationCount, latestMigrationTag: manifest.latestMigrationTag, counts: { retentionReceipts: manifest.retentionReceipts.length, activeHolds: manifest.activeHolds.length, retentionPolicies: manifest.retentionPolicies.length, subjectExecutionReceipts: manifest.subjectExecutionReceipts.length } }));
    return 0;
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : 'UNAVAILABLE';
    console.log(JSON.stringify({ status: 'BLOCKED', stage, counts: { [code]: 1 } }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runRecoveryExport();
