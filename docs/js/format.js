// Wording for dates and for the "Last checked for new sites" status line.

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayDifference(nowMs, thenMs) {
  return Math.round((startOfDay(nowMs) - startOfDay(thenMs)) / DAY);
}

export function formatTime(ms, locale) {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

// "today at 9:41 AM", "yesterday at 6:02 PM", "on Sep 24 at 8:15 AM"
export function formatWhen(iso, nowMs = Date.now(), locale = undefined) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const days = dayDifference(nowMs, then);
  const time = formatTime(then, locale);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const sameYear = new Date(nowMs).getFullYear() === new Date(then).getFullYear();
  const options = sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `on ${new Intl.DateTimeFormat(locale, options).format(new Date(then))} at ${time}`;
}

// "10:15 AM" today, otherwise "tomorrow at 9:00 AM" or a date.
export function formatUntil(iso, nowMs = Date.now(), locale = undefined) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const days = dayDifference(then, nowMs);
  if (days === 0) return formatTime(then, locale);
  if (days === 1) return `tomorrow at ${formatTime(then, locale)}`;
  return formatWhen(iso, nowMs, locale);
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function listTitles(titles, max = 3) {
  if (titles.length <= max) {
    if (titles.length <= 2) return titles.join(' and ');
    return `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`;
  }
  return `${titles.slice(0, max).join(', ')}, and ${titles.length - max} more`;
}

function reasonText(reason, retryAt, nowMs, locale) {
  switch (reason) {
    case 'offline':
      return "you’re offline";
    case 'network':
      return "the library couldn’t reach GitHub";
    case 'timeout':
      return 'GitHub took too long to answer';
    case 'rate-limited':
      return retryAt
        ? `GitHub asked the library to wait until ${formatUntil(retryAt, nowMs, locale)}`
        : 'GitHub asked the library to wait';
    case 'owner-not-found':
      return "GitHub couldn’t find the account";
    case 'server-error':
      return 'GitHub had a problem answering';
    case 'too-many-pages':
      return 'there were more repositories than one check reads';
    case 'unexpected-listing':
      return "GitHub’s answer didn’t include any of the sites already here";
    case 'bad-response':
      return 'GitHub sent an answer the library could not read';
    default:
      return reason && reason.startsWith('http-') ? 'GitHub refused the request' : 'something went wrong';
  }
}

/**
 * Builds the status line. `tone` is 'ok', 'warn', 'busy', or 'info'.
 * A successful check that found nothing reads differently from a check that
 * could not finish, and the time shown is when the library last looked for
 * sites, not a review of their content.
 */
export function describeStatus({ checks, nowMs = Date.now(), online = true, checking = false, titleFor = (k) => k, locale }) {
  if (checking) return { tone: 'busy', text: 'Checking for new sites' };
  const last = checks.last;
  const lastOk = checks.lastSuccessAt;
  const since = lastOk ? `last checked ${formatWhen(lastOk, nowMs, locale)}` : null;

  if (!last) {
    if (!online) {
      return { tone: 'warn', text: "You’re offline. The library will check for new sites when you’re back online." };
    }
    return { tone: 'info', text: 'Not checked for new sites yet.' };
  }

  const added = last.added.map(titleFor);
  const found = added.length ? ` Found ${plural(added.length, 'new site')}: ${listTitles(added)}.` : '';
  const pending = last.unconfirmed
    ? ` ${last.unconfirmed === 1 ? '1 possible new site' : `${last.unconfirmed} possible new sites`} couldn’t be confirmed yet and will be checked again.`
    : '';

  if (last.outcome === 'complete') {
    return {
      tone: 'ok',
      text: `Last checked for new sites ${formatWhen(last.at, nowMs, locale)}.${found || ' No new sites.'}${pending}`,
    };
  }

  const why = reasonText(last.reason, last.retryAt, nowMs, locale);
  const lead =
    last.outcome === 'partial'
      ? `The last check for new sites didn’t finish (${why}). Nothing was removed.${found}`
      : `Couldn’t check for new sites (${why}).`;
  const tail = since ? ` Showing your saved library, ${since}.` : ' Showing your saved library.';
  const offline = !online && last.reason !== 'offline' ? " You’re offline now." : '';
  return { tone: 'warn', text: `${lead}${tail}${offline}` };
}
