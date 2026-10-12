'use strict';

// Where a FAIL reason comes from: the model's
// own judgement, or a check computed by code. second-run.js decides on this
// source, never on the reason text.
const SOURCE_MODEL = 'model';
const SOURCE_DETERMINISTIC = 'deterministic';

// Every reason carries a code from the closed list (result.js plus the codes
// checks declare at registration) and the issue ID it is about (null when it
// is about no single item). Both are set where the reason is created, never
// parsed back out of the text.
const createReason = (source) => (code, text, id = null) => ({
  text,
  source,
  code,
  id,
});
const modelReason = createReason(SOURCE_MODEL);
const deterministicReason = createReason(SOURCE_DETERMINISTIC);

module.exports = {
  SOURCE_MODEL,
  SOURCE_DETERMINISTIC,
  modelReason,
  deterministicReason,
};
