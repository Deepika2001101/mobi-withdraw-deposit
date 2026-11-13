'use strict';
const Constants = require('../constants/PoConstants');
const state = { timer: null, running: false, ticks: 0, skipped: 0 };

async function tick(srv, opts) {
  if (state.running) {
    state.skipped += 1;
    console.warn('[PoAutoScheduler] previous run still in flight - skipping this tick.');
    return;
  }
  state.running = true;
  try {
    const params = opts.dryRun ? { dryRun: true } : {};
    const result = await srv.send('triggerPoMailNotification', params);
    state.ticks += 1;
    console.log(`[PoAutoScheduler] tick ${state.ticks}${opts.dryRun ? ' (dry run)' : ''}: ${result?.message || 'completed'}`);
  } catch (error) {
    console.error(`[PoAutoScheduler] tick failed: ${error.message}`);
  } finally {
    state.running = false;
  }
}

/**
 * Start the interval explicitly (used by tests and by attach()).
 * @param {object} srv            the CAP service (has .send())
 * @param {object} [opts]         { intervalMs, firstDelayMs, dryRun }
 */
function start(srv, opts = {}) {
  if (state.timer) return state;                       // already running
  const intervalMs = Math.max(Number(opts.intervalMs) || 5 * 60000, 10);
  const firstDelayMs = Math.max(Number(opts.firstDelayMs) ?? 30000, 0);

  const fire = () => { tick(srv, opts); };
  state.timer = setTimeout(() => {
    fire();
    state.timer = setInterval(fire, intervalMs);
    state.timer.unref?.();
  }, firstDelayMs);
  state.timer.unref?.();

  console.log(
    `[PoAutoScheduler] enabled - every ${Math.round(intervalMs / 60000)} min ` +
    `(first tick in ${Math.round(firstDelayMs / 1000)}s${opts.dryRun ? ', DRY RUN' : ''}).`
  );
  return state;
}

function attach(srv) {
  if (!Constants.AUTO_RUN_ENABLED) {
    console.log('[PoAutoScheduler] disabled (set PO_MAIL_AUTO_RUN=true to enable the in-app timer).');
    return state;
  }
  return start(srv, {
    intervalMs: Constants.AUTO_RUN_INTERVAL_MIN * 60000,
    firstDelayMs: Constants.AUTO_RUN_STARTUP_DELAY_SEC * 1000,
    dryRun: Constants.AUTO_RUN_DRY_RUN
  });
}

function stop() {
  if (state.timer) clearTimeout(state.timer);          
  state.timer = null;
  return state;
}

function describe() {
  if (!Constants.AUTO_RUN_ENABLED) {
    return 'disabled - set PO_MAIL_AUTO_RUN=true and restart to auto-mail new POs without the Job Scheduler';
  }
  return `enabled - every ${Constants.AUTO_RUN_INTERVAL_MIN} min` +
    ` (first tick +${Constants.AUTO_RUN_STARTUP_DELAY_SEC}s${Constants.AUTO_RUN_DRY_RUN ? ', DRY RUN' : ''}),` +
    ` ticks=${state.ticks}, skipped=${state.skipped}, running=${state.running ? 'yes' : 'no'}`;
}

module.exports = { attach, start, stop, tick, state, describe };