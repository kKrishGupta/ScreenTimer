import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSyncAlarm, singleFlight, SYNC_ALARM_NAME } from '../background/sync-scheduler.js';

function alarmApi(initialAlarm = null) {
  let alarm = initialAlarm;
  const creates = [];
  return {
    creates,
    chromeApi: {
      alarms: {
        async get(name) {
          assert.equal(name, SYNC_ALARM_NAME);
          return alarm;
        },
        async create(name, options) {
          creates.push({ name, options });
          alarm = { name, scheduledTime: Date.now() + options.periodInMinutes * 60_000, ...options };
        },
      },
    },
  };
}

test('does not replace an existing periodic sync alarm when the worker restarts', async () => {
  const existing = { name: SYNC_ALARM_NAME, scheduledTime: 12345, periodInMinutes: 0.5 };
  const { chromeApi, creates } = alarmApi(existing);

  const result = await ensureSyncAlarm(chromeApi, 30);

  assert.equal(result, existing);
  assert.deepEqual(creates, []);
});

test('creates the periodic sync alarm when browser state no longer has it', async () => {
  const { chromeApi, creates } = alarmApi();

  const result = await ensureSyncAlarm(chromeApi, 30);

  assert.equal(result.name, SYNC_ALARM_NAME);
  assert.deepEqual(creates, [{ name: SYNC_ALARM_NAME, options: { periodInMinutes: 0.5 } }]);
});

test('coalesces overlapping automatic and manual synchronization requests', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = singleFlight(async () => {
    calls += 1;
    await gate;
    return { ok: true };
  });

  const automatic = run('alarm');
  const manual = run('popup');
  assert.equal(automatic, manual);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await automatic, { ok: true });

  await run('later-alarm');
  assert.equal(calls, 2);
});
