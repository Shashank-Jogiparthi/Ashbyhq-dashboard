/**
 * core/submission-banner.js — read what Ashby actually said when the engine
 * could not classify the page.
 *
 * The engine recognises two acknowledgements after a Submit click: success and
 * missing-fields. Anything else it stores as 'unknown' — along with the full
 * visible page text in bannerText, which the dashboard was throwing away.
 *
 * That is how a run that got the red "We couldn't submit your application /
 * Your application submission was flagged as possible spam" banner ended up as
 * PENDING "Outcome unclear": the applicant's card blamed nothing, and the
 * screenshot that explained it sat unopened. Ashby's spam banner is a real,
 * named outcome — the submission did NOT go through, and it is not the
 * applicant's fault — so it deserves its own sentence rather than a shrug.
 *
 * Deliberately narrow: it only labels a banner it can quote. An unrecognised
 * page stays "Outcome unclear", because guessing that a submission worked (or
 * failed for a reason we invent) is worse than admitting we cannot read it.
 *
 * The engine itself is not touched: it already hands us the page text, which is
 * the evidence this needs.
 */

/** Ashby's anti-spam rejection, in its own words. */
const SPAM_SIG = /flagged as possible spam|couldn.?t submit your application|submission was flagged/i;

/** First line of the page text that actually carries the signal. */
function bannerLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => SPAM_SIG.test(line)) || '';
}

/**
 * Classify an 'unknown' post-submit page from its banner text.
 * Returns { kind, reason } when we can name the outcome, otherwise null.
 */
export function readUnknownBanner(bannerText) {
  const text = String(bannerText || '');
  if (!SPAM_SIG.test(text)) return null;
  const line = (bannerLine(text) || 'Your application submission was flagged as possible spam.').slice(0, 160);
  return {
    kind: 'spam',
    reason: 'Ashby flagged this submission as possible spam - NOT submitted '
      + `("${line}"). This host's network is what Ashby distrusted (datacenter IP, and/or several `
      + 'submissions from it at once), not the applicant - re-queue it for a run from a home connection.'
  };
}
