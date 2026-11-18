export function getE2ERunId(value = process.env.LOOM_E2E_RUN_ID ?? 'default') {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}
