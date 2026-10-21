'use strict';

const { authorizeLabel } = require('../verifier/label-authority');
const { STATUS_ENABLED, STATUS_DISABLED } = require('./config');

// Decides whether Calibration Judge analyses a verifier round. The label name
// comes from the project profile (through config); nothing project-specific
// is fixed here.
//
// Events: 'round' (the verifier finished a round), 'labeled' (the label was
// added; the round on the current head must already be finished) and
// 'manual' (a person started Judge). A manual start skips only the verdict and
// label conditions; a disabled or misconfigured Judge stays off for it too.

const EVENT_ROUND = 'round';
const EVENT_LABELED = 'labeled';
const EVENT_MANUAL = 'manual';

const ANALYSED_VERDICTS = new Set(['FAIL', 'NEEDS_HUMAN']);

const run = (reason) => ({ run: true, configError: false, reason });
const skip = (reason) => ({ run: false, configError: false, reason });
const configError = (reason) => ({ run: false, configError: true, reason });

const labelHolder = (label, owners, targets) =>
  targets.find(
    ({ timeline }) => authorizeLabel(timeline, owners, label).authorized,
  ) ?? null;

const decideByConfig = (config) => {
  if (config?.status === STATUS_DISABLED) {
    return skip('judge is disabled in the profile');
  }
  if (config?.status !== STATUS_ENABLED) {
    return configError(config?.reason ?? 'judge configuration is unknown');
  }
  if (typeof config.label !== 'string' || config.label === '') {
    return configError('calibration label was not given');
  }
  return null;
};

const decideTrigger = ({
  config,
  event,
  verdict,
  owners,
  pullTimeline,
  issueTimeline,
  eventLabel,
  roundHead,
  currentHead,
}) => {
  const byConfig = decideByConfig(config);
  if (byConfig !== null) return byConfig;
  if (event === EVENT_MANUAL) return run('manual start');
  if (event !== EVENT_ROUND && event !== EVENT_LABELED) {
    return skip('unknown trigger event');
  }
  if (!ANALYSED_VERDICTS.has(verdict)) {
    return skip('verdict is not FAIL or NEEDS_HUMAN');
  }
  const { label } = config;
  if (event === EVENT_LABELED) {
    if (eventLabel !== label) return skip('event is for another label');
    if (!roundHead || roundHead !== currentHead) {
      return skip('verifier round has not finished on the current head');
    }
  }
  const holder = labelHolder(label, owners, [
    { name: 'pull request', timeline: pullTimeline },
    { name: 'issue', timeline: issueTimeline },
  ]);
  return holder === null
    ? skip('no label set by an owner on the issue or the pull request')
    : run(`${verdict} round, label set by an owner on the ${holder.name}`);
};

module.exports = {
  EVENT_ROUND,
  EVENT_LABELED,
  EVENT_MANUAL,
  decideTrigger,
};
