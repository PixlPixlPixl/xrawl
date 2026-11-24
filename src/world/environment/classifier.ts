/**
 * Environment classification — a light, deterministic read of "what kind of
 * page is this?" Used later to gate creature behaviours (a docs page and a
 * shop are different foraging grounds). Pure function over page metadata and
 * a small set of DOM hints; no browser APIs.
 */
import type { EnvironmentClassification, EnvironmentKind, PageInfo } from '@/shared/types/page';

export interface EnvironmentHints {
  readonly ogType: string;
  readonly hasArticle: boolean;
  readonly hasCodeBlock: boolean;
  readonly hasPrice: boolean;
  readonly hasSearchInput: boolean;
  readonly hasEditableMailForm: boolean;
}

interface Signal {
  readonly kind: EnvironmentKind;
  readonly weight: number;
  readonly reason: string;
}

const HOST_SIGNALS: ReadonlyArray<{ pattern: RegExp; kind: EnvironmentKind; weight: number; label: string }> = [
  { pattern: /^(www\.)?(github|gitlab|gitea|bitbucket)\./, kind: 'code', weight: 3, label: 'code host' },
  { pattern: /^(www\.)?(stackoverflow|stackexchange|serverfault|superuser)\./, kind: 'forum', weight: 3, label: 'Q&A host' },
  { pattern: /^(www\.)?(reddit|news\.ycombinator|discourse)\./, kind: 'forum', weight: 3, label: 'discussion host' },
  { pattern: /^(www\.)?(twitter|x|facebook|instagram|threads|bsky|mastodon|tiktok)\./, kind: 'social', weight: 3, label: 'social host' },
  { pattern: /^(www\.)?(youtube|youtu\.be|vimeo|twitch|dailymotion)\./, kind: 'video', weight: 3, label: 'video host' },
  { pattern: /^(www\.)?(amazon|ebay|etsy|walmart|shopify|aliexpress|temu)\./, kind: 'commerce', weight: 3, label: 'shop host' },
  { pattern: /^(mail\.google|outlook\.live|outlook\.office|mail\.yahoo|proton\.mail)\./, kind: 'email', weight: 3, label: 'mail host' },
  { pattern: /^docs\./, kind: 'docs', weight: 3, label: 'docs subdomain' },
];

const PATH_SIGNALS: ReadonlyArray<{ pattern: RegExp; kind: EnvironmentKind; weight: number; label: string }> = [
  { pattern: /^\/docs?(\/|$)|^\/reference|^\/api(\/|$)|^\/manual|^\/guide|^\/wiki/, kind: 'docs', weight: 3, label: 'docs path' },
  { pattern: /^\/watch(\/|$)|^\/video|^\/shorts|^\/v(\/|$)/, kind: 'video', weight: 3, label: 'video path' },
  { pattern: /^\/search|^\/results|^\/(find|query)(\/|$)/, kind: 'search', weight: 2, label: 'search path' },
  { pattern: /^\/product|^\/cart|^\/checkout|^\/shop(\/|$)|^\/store(\/|$)/, kind: 'commerce', weight: 3, label: 'shop path' },
  { pattern: /^\/questions\/|^\/threads?\/|^\/discussion|^\/comments?/i, kind: 'forum', weight: 2, label: 'thread path' },
  { pattern: /^\/mail(\/|$)|^\/inbox/, kind: 'email', weight: 3, label: 'mail path' },
];

function parseUrl(url: string): { host: string; path: string; query: URLSearchParams } | null {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.replace(/^www\./, '').toLowerCase(),
      path: parsed.pathname.toLowerCase(),
      query: parsed.searchParams,
    };
  } catch {
    return null;
  }
}

export function classifyEnvironment(page: PageInfo, hints: EnvironmentHints): EnvironmentClassification {
  const parsed = parseUrl(page.url);
  const scores = new Map<EnvironmentKind, { score: number; reasons: string[] }>();
  const signals: Signal[] = [];

  const add = (kind: EnvironmentKind, weight: number, reason: string) => {
    signals.push({ kind, weight, reason });
  };

  if (parsed) {
    for (const signal of HOST_SIGNALS) {
      if (signal.pattern.test(parsed.host)) add(signal.kind, signal.weight, signal.label);
    }
    for (const signal of PATH_SIGNALS) {
      if (signal.pattern.test(parsed.path)) add(signal.kind, signal.weight, signal.label);
    }

    const query = parsed.query;
    if (query.get('q') !== null || query.get('query') !== null || query.get('s') !== null) {
      add('search', 2, 'search query string');
    }
    if (query.get('v') !== null) add('video', 2, 'video query parameter');
    if (/^\/docs\./.test(parsed.host)) add('docs', 3, 'docs subdomain');
  }

  if (hints.ogType.toLowerCase().includes('article')) add('article', 3, 'og:type article');
  if (hints.ogType.toLowerCase().includes('video')) add('video', 3, 'og:type video');
  if (hints.hasArticle) add('article', 2, 'article element');
  if (hints.hasCodeBlock) add('code', 2, 'code block present');
  if (hints.hasPrice) add('commerce', 2, 'price markup');
  if (hints.hasSearchInput) add('search', 2, 'search input');
  if (hints.hasEditableMailForm) add('email', 2, 'mail form');

  const title = page.title.toLowerCase();
  if (/documentation|api reference|developer/.test(title)) add('docs', 1, 'title wording');
  if (/video|channel|episode/.test(title)) add('video', 1, 'title wording');
  if (/tutorial|guide|article|how to/.test(title)) add('article', 1, 'title wording');

  for (const signal of signals) {
    const entry = scores.get(signal.kind) ?? { score: 0, reasons: [] };
    entry.score += signal.weight;
    entry.reasons.push(signal.reason);
    scores.set(signal.kind, entry);
  }

  let bestKind: EnvironmentKind = 'unknown';
  let bestScore = 0;
  let bestReasons: string[] = [];

  for (const [kind, entry] of scores) {
    if (entry.score > bestScore) {
      bestKind = kind;
      bestScore = entry.score;
      bestReasons = entry.reasons;
    }
  }

  if (bestScore === 0 || bestKind === 'unknown') {
    return { kind: 'unknown', confidence: 0, reasons: [] };
  }

  return {
    kind: bestKind,
    confidence: Math.min(1, bestScore / 6),
    reasons: bestReasons.slice(0, 6),
  };
}

/** Cheap DOM probes; run once per measurement pass, never per word. */
export function collectEnvironmentHints(document: Document): EnvironmentHints {
  const meta = (selector: string): string =>
    document.querySelector(selector)?.getAttribute('content') ?? '';

  return {
    ogType: meta('meta[property="og:type"]') || meta('meta[name="og:type"]'),
    hasArticle: document.querySelector('article') !== null,
    hasCodeBlock: document.querySelector('pre > code, pre') !== null,
    hasPrice: document.querySelector('[itemtype*="Offer"], [class*="price"], [data-price]') !== null,
    hasSearchInput:
      document.querySelector('input[type="search"], input[name="q"], input[name="query"]') !== null,
    hasEditableMailForm:
      document.querySelector('[contenteditable="true"][role="textbox"], input[type="email"]') !== null,
  };
}
