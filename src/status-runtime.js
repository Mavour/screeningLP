const state = {
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  activeScans: 0,
  lastScanStartedAt: null,
  stopping: false,
};

function heartbeat() {
  state.heartbeatAt = new Date().toISOString();
}

function scanStarted() {
  state.activeScans += 1;
  state.lastScanStartedAt = new Date().toISOString();
}

function scanFinished() {
  state.activeScans = Math.max(0, state.activeScans - 1);
}

function stopping() {
  state.stopping = true;
}

function get() {
  return { ...state };
}

module.exports = { heartbeat, scanStarted, scanFinished, stopping, get };
