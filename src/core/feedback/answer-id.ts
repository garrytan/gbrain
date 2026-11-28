/** The shape of an answer id (`ans_<ULID>`), kept apart so the served member policy can check it without the recording queue. */
export const ANSWER_ID_RE = /^ans_[0-9A-HJKMNP-TV-Z]{26}$/;
