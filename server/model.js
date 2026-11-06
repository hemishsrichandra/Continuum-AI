import { setTimeout as delay } from 'node:timers/promises';

// Retrying a model request cannot commit a business action. Bound both attempts
// and delay; longer provider cooldowns remain explicit for the caller.
export async function modelFetch(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    if (![429, 503].includes(response.status) || attempt >= 2) return response;
    const retry = response.headers.get('retry-after');
    const numeric = retry === null ? NaN : Number(retry);
    const milliseconds = Number.isFinite(numeric)
      ? numeric * 1000
      : retry
        ? Date.parse(retry) - Date.now()
        : 1000 * 2 ** attempt;
    if (milliseconds > 30000) return response;
    await response.body?.cancel();
    await delay(Math.max(1000, Number.isFinite(milliseconds) ? milliseconds : 1000));
  }
}
