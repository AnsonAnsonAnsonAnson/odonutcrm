// Every 5 minutes: sends scheduled campaigns and, once a day after 10:00 HK time, the birthday,
// win-back, almost-there, tier review and voucher expiry jobs (each guarded so it runs once).
import { runScheduledJobs } from '../../server/src/netlify.ts';

export default async () => {
  await runScheduledJobs();
};

export const config = {
  schedule: '*/5 * * * *',
};
