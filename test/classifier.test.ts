/**
 * Environment classification tests.
 *
 * The classifier decides what a page *is* (and therefore what the creature
 * learns from it). It is a pure function over URL, title and a handful of DOM
 * hints, so the rules can be pinned down here instead of by browsing around.
 */
import { describe, expect, it } from 'vitest';
import { classifyEnvironment, type EnvironmentHints } from '@/world/environment/classifier';

const NO_HINTS: EnvironmentHints = {
  ogType: '',
  hasArticle: false,
  hasCodeBlock: false,
  hasPrice: false,
  hasSearchInput: false,
  hasEditableMailForm: false,
};

function classify(url: string, title = '', hints: Partial<EnvironmentHints> = {}) {
  return classifyEnvironment({ url, title }, { ...NO_HINTS, ...hints });
}

describe('host and path signals', () => {
  it('recognises a code host over its article-looking page', () => {
    const result = classify('https://github.com/wxt-dev/wxt/pull/1', 'A pull request', {
      hasArticle: true,
    });
    expect(result.kind).toBe('code');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasons).toContain('code host');
  });

  it('recognises a docs path and a docs subdomain', () => {
    expect(classify('https://example.com/docs/getting-started').kind).toBe('docs');
    expect(classify('https://docs.example.com/guide').kind).toBe('docs');
  });

  it('recognises video, shop, search and mail pages', () => {
    expect(classify('https://youtube.com/watch?v=abc').kind).toBe('video');
    expect(classify('https://shop.example.com/product/42').kind).toBe('commerce');
    expect(classify('https://example.com/search?q=cats').kind).toBe('search');
    expect(classify('https://mail.google.com/mail/u/0').kind).toBe('email');
  });

  it('ignores a host it does not know', () => {
    const result = classify('https://some-personal-blog.dev/notes');
    expect(result.kind).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('survives an unparseable URL', () => {
    const result = classifyEnvironment({ url: 'not a url', title: '' }, { ...NO_HINTS, hasArticle: true });
    expect(result.kind).toBe('article');
  });
});

describe('DOM and metadata hints', () => {
  it('prefers a strong host signal to a weak DOM hint', () => {
    const result = classify('https://stackoverflow.com/questions/1', 'How do I x?', {
      hasCodeBlock: true,
    });
    expect(result.kind).toBe('forum');
  });

  it('classifies an article from og:type and the element', () => {
    const result = classify('https://example.com/story', 'A long read', {
      ogType: 'article',
      hasArticle: true,
    });
    expect(result.kind).toBe('article');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('uses the title only as supporting evidence', () => {
    expect(classify('https://example.com/x', 'API reference').kind).toBe('docs');
  });

  it('never reports a confidence above 1 or more than six reasons', () => {
    const result = classify('https://example.com/docs/api/guide', 'documentation', {
      ogType: 'article',
      hasArticle: true,
      hasCodeBlock: true,
      hasSearchInput: true,
    });
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasons.length).toBeLessThanOrEqual(6);
  });
});
