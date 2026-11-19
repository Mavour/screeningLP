import { discover, summarize, verification } from '../discovery/leaderboard.js';
import { evaluateCohort } from '../discovery/smart-lp.js';
import { flushBatches, processInbox } from '../realtime/worker.js';
import { watchActivity } from '../realtime/watch.js';
import { refreshIntel } from '../intel/pools.js';
import { refreshDueWallets } from './wallets.js';

export function startJobs(ctx) {
  const watcher = watchActivity(ctx);
  const jobs = [];
  let stopping = false;

  function schedule(name, interval, operation, initial = 0) {
    const job = { timer: null, running: null };
    jobs.push(job);
    const run = () => {
      job.running = Promise.resolve().then(operation).catch(error => {
        if (!stopping) ctx.logger.warn({ reason: error.message, job: name }, 'Scheduled job failed');
      }).finally(() => {
        if (!stopping) job.timer = setTimeout(run, interval);
      });
    };
    job.timer = setTimeout(run, initial);
  }

  schedule('event ingestion', 500, () => processInbox(ctx));
  schedule('alert delivery', 500, () => flushBatches(ctx));
  schedule('wallet refresh', 3000, () => refreshDueWallets(ctx), 1000);
  schedule('watchlist sync', 60000, () => watcher.sync());
  schedule('discovery', ctx.settings.discoveryMs, async () => {
    await discover(ctx);
    if (!stopping) await watcher.sync();
  });
  schedule('pool intelligence', ctx.settings.trendMs, () => refreshIntel(ctx), 1500);
  schedule('Smart LP evaluation', ctx.settings.discoveryMs, () => evaluateCohort(ctx, summarize, verification), 5000);

  return async () => {
    stopping = true;
    for (const job of jobs) clearTimeout(job.timer);
    await Promise.allSettled([watcher.close(), ...jobs.map(job => job.running)]);
  };
}
