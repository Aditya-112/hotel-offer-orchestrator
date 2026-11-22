const worker = process.argv[2] === 'worker';
const port = worker ? process.env.WORKER_HEALTH_PORT ?? '3002' : process.env.PORT ?? '3000';
try {
  const response = await fetch(`http://127.0.0.1:${port}/${worker ? 'ready' : 'health'}`, { signal: AbortSignal.timeout(2500) });
  await response.body?.cancel();
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
