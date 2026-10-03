export const EXPECTED_MIGRATION_COUNT = 21;
export const EXPECTED_LATEST_MIGRATION_TAG = '0020_subject_request_governance';

// Static release descriptor. Runtime probes never read SQL from disk.
export const MIGRATION_DESCRIPTOR = Object.freeze({
  count: 21,
  tag: '0020_subject_request_governance',
  timestamp: 1791017773296,
  hash: 'a3ad775bb706c9e26a95cd5b2c00cd4abefe3b517f4cabd7cc337e58ae305331',
  // Explicitly approved Windows checkout newline variant; no generic normalization at runtime.
  approvedCrlfHash: 'a1bc9fe64e87d38cfaa2acff247e689ac85adc8c1a3417f0a34f9128ca52423f',
});
