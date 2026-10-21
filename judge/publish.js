'use strict';

const crypto = require('node:crypto');
const {
  COMMENT_MARKER,
  isSameRound,
  encodeRounds,
  decodeRounds,
  renderComment,
} = require('./render');

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toRoundKey = ({ repository, runId, runAttempt }) => ({
  repository: String(repository),
  verifier_run_id: String(runId),
  verifier_run_attempt: String(runAttempt),
});

// Deep, recursive key sort (array element order is kept — only object key
// order is normalized) so the same analysis content hashes the same
// regardless of the order the model emitted its JSON keys in.
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
};

const sha256Of = (text) => crypto.createHash('sha256').update(text).digest('hex');

const hashAnalysis = (analysis) => sha256Of(JSON.stringify(canonicalize(analysis)));

// Records written before canonical hashing hashed the JSON as emitted, so an
// identical analysis redelivered now must also be recognised by that hash.
const legacyHashAnalysis = (analysis) => sha256Of(JSON.stringify(analysis));

// Only the comment written by the expected author counts: a marker copied
// into a comment by a person or another bot is never read or edited. The
// author login is passed in by the caller, never hardcoded here.
const findOwnComment = (comments, author) => {
  if (!Array.isArray(comments)) return null;
  const isOwn = (comment) =>
    isObject(comment) &&
    isObject(comment.user) &&
    comment.user.login === author &&
    typeof comment.body === 'string' &&
    comment.body.includes(COMMENT_MARKER);
  return comments.find(isOwn) ?? null;
};

// Appends a new revision for this round, or returns the existing record
// unchanged when the exact same analysis is delivered again (a
// redelivered event is a no-op, not a new revision). Other rounds' records
// are never touched. A revision already written concurrently for
// this round is still picked up as the current one (it was read fresh by the
// caller), so the new revision is numbered one past it and the concurrent
// one moves into `history` rather than being discarded.
const mergeRecord = (previous, roundKey, analysis) => {
  const sha256 = hashAnalysis(analysis);
  const index = previous.findIndex((item) => isSameRound(item.round_key, roundKey));
  const existing = index === -1 ? null : previous[index];
  const isDuplicate =
    existing !== null &&
    (existing.sha256 === sha256 || existing.sha256 === legacyHashAnalysis(analysis));
  if (isDuplicate && existing.analysis !== null) {
    return { records: previous, record: existing };
  }
  if (isDuplicate) {
    // The same revision, compressed out of the comment earlier: its content
    // comes back from the redelivered analysis, its number and hash stay.
    const restored = {
      round_key: existing.round_key,
      revision: existing.revision,
      sha256: existing.sha256,
      analysis,
      history: existing.history,
    };
    const records = previous.map((item, i) => (i === index ? restored : item));
    return { records, record: restored };
  }
  const revision = (existing?.revision ?? 0) + 1;
  const history =
    existing === null
      ? []
      : [...existing.history, { revision: existing.revision, sha256: existing.sha256 }];
  const record = { round_key: roundKey, revision, sha256, analysis, history };
  const records =
    index === -1 ? [...previous, record] : previous.map((item, i) => (i === index ? record : item));
  return { records, record };
};

// Builds the comment body for this round. Returns the id of the comment to
// update (null when a new comment must be created) and the merged records.
const publish = ({ comments, author, roundKey, assembled, maxBodyLength }) => {
  const own = findOwnComment(comments, author);
  const decoded = own === null ? null : decodeRounds(own.body);
  const previous = decoded === null ? [] : decoded.records;
  const historyError = decoded === null || decoded.ok ? null : decoded.error;
  const { records, record } = mergeRecord(previous, roundKey, assembled);
  const body = renderComment({ records, record, historyError, maxBodyLength });
  return {
    commentId: own === null ? null : own.id,
    body,
    records,
    record,
    historyError,
  };
};

// Whether `record`'s exact revision is present in the own comment of
// `comments` — used right after a write to confirm it actually took effect
//, not merely that some revision of the round exists.
const isRecordPresent = (comments, author, record) => {
  const own = findOwnComment(comments, author);
  if (own === null) return false;
  const decoded = decodeRounds(own.body);
  if (!decoded.ok) return false;
  return decoded.records.some(
    (candidate) =>
      isSameRound(candidate.round_key, record.round_key) &&
      candidate.revision === record.revision &&
      candidate.sha256 === record.sha256,
  );
};

const ownBodyOf = (comments, author) => findOwnComment(comments, author)?.body ?? null;

// Whether the comment's own body is still exactly what the merge in this
// attempt was computed from. Checking only "is my own revision present"
// after the write (isRecordPresent) cannot tell a clean write apart from one
// that silently overwrote a concurrent round's record with stale data — both
// leave my own revision present. Comparing bodies before writing closes that
// gap: a mismatch means another process wrote after this attempt's merge was
// computed, so writing now would discard that write.
const commentUnchangedSince = (before, after, author) =>
  ownBodyOf(before, author) === ownBodyOf(after, author);

const DEFAULT_MAX_ATTEMPTS = 5;

// Retries a publish end to end. Each attempt rereads the comment right
// before merging (a round added concurrently before this read is
// picked up because the merge always runs against freshly read text), then
// rereads once more immediately before writing: if the comment changed since
// the merge was computed — a concurrent process wrote in between — this
// attempt is abandoned without writing, so it never overwrites that write
// with its own stale merge; the next attempt starts over from a fresh read.
// Otherwise it writes, then rereads again to confirm the just-written
// revision is actually there before declaring success. A write whose
// verification read does not find it is retried from the top — re-read,
// re-merge, re-write — rather than merely re-verified, since the comment
// could have been replaced entirely by a concurrent run between the write
// and the verify read. Exhausting `maxAttempts` returns a failure rather
// than throwing, so the caller (the CLI) turns it into a plain non-zero
// exit. `readComments`/`writeComment` are injected synchronous functions:
// this function makes no network call itself — the real caller
// backs them with `gh api` calls using array arguments. This narrows but
// does not eliminate the race: a write can still land in the gap between
// the recheck read and the write call itself, since plain `gh api` offers no
// conditional/compare-and-swap write.
const publishWithRetry = ({
  author,
  roundKey,
  assembled,
  maxBodyLength,
  readComments,
  writeComment,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) => {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const comments = readComments();
    const result = publish({ comments, author, roundKey, assembled, maxBodyLength });
    const recheck = readComments();
    if (!commentUnchangedSince(comments, recheck, author)) continue;
    writeComment(result.commentId, result.body);
    lastResult = result;
    const verifyComments = readComments();
    if (isRecordPresent(verifyComments, author, result.record)) {
      return { ok: true, attempts: attempt, result };
    }
  }
  return { ok: false, attempts: maxAttempts, result: lastResult };
};

module.exports = {
  toRoundKey,
  hashAnalysis,
  findOwnComment,
  encodeRounds,
  decodeRounds,
  mergeRecord,
  isRecordPresent,
  publish,
  publishWithRetry,
};
