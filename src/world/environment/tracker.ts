/**
 * Tracks page identity and its environment classification across a session.
 *
 * Navigation itself is observed by the platform layer; this tracker just
 * recomputes when it is told to and reports whether anything material
 * changed (URL/title).
 */
import type { EnvironmentClassification, PageInfo } from '@/shared/types/page';
import { classifyEnvironment, collectEnvironmentHints, type EnvironmentHints } from './classifier';

export interface EnvironmentRefresh {
  readonly page: PageInfo;
  readonly environment: EnvironmentClassification;
  readonly changed: boolean;
}

const UNKNOWN: EnvironmentClassification = { kind: 'unknown', confidence: 0, reasons: [] };

export class EnvironmentTracker {
  private page: PageInfo = { url: '', title: '' };
  private environment: EnvironmentClassification = UNKNOWN;
  private hints: EnvironmentHints | null = null;

  get currentPage(): PageInfo {
    return this.page;
  }

  get currentEnvironment(): EnvironmentClassification {
    return this.environment;
  }

  refresh(document: Document): EnvironmentRefresh {
    const nextPage: PageInfo = { url: document.URL, title: document.title.trim() };
    const changed = nextPage.url !== this.page.url || nextPage.title !== this.page.title;

    if (!changed && this.hints !== null) {
      return { page: this.page, environment: this.environment, changed: false };
    }

    this.page = nextPage;
    this.hints = collectEnvironmentHints(document);
    this.environment = classifyEnvironment(this.page, this.hints);

    return { page: this.page, environment: this.environment, changed: true };
  }

  reset(): void {
    this.page = { url: '', title: '' };
    this.environment = UNKNOWN;
    this.hints = null;
  }
}
