import './style.css';
import { sendRuntimeMessage } from '@/platform/browser/messaging';
import type {
  JournalFeedingsPage,
  JournalFeedingsQuery,
  JournalOverview,
  JournalQuery,
  JournalSettings,
  JournalVocabularyPage,
  JournalVocabularyQuery,
  JournalWord,
  JournalWordDetail,
} from '@/shared/types/journal';
import { environmentLabel } from '@/shared/types/journal';

/**
 * The journal page.
 *
 * It is a *reader*: every number on this screen already exists in the database,
 * and nothing here can change gameplay. That is the point - a history you can
 * check is what makes "is it eating the right words?" a question with an answer.
 *
 * Everything is built as DOM nodes with textContent, never as HTML strings, so
 * page titles and words from arbitrary sites cannot become markup here.
 */

const PAGE_SIZE = 40;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error('journal element #' + id + ' is missing');
  return found as T;
}

type Child = string | number | Node | false | null | undefined;
/** Mutable view of a `readonly` query type, so filters can be attached by branch. */
type MutableQuery<T> = { -readonly [K in keyof T]: T[K] };

/** `replaceChildren` only accepts strings and nodes; numbers and holes are ours. */
function nodesOf(children: ReadonlyArray<Child>): Array<string | Node> {
  const out: Array<string | Node> = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    out.push(typeof child === 'number' ? String(child) : child);
  }
  return out;
}

interface Props {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  href?: string;
  data?: Record<string, string>;
  width?: string;
  hidden?: boolean;
}

function h(tag: string, props: Props = {}, children: Child[] = []): HTMLElement {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.setAttribute('title', props.title);
  if (props.type !== undefined) node.setAttribute('type', props.type);
  if (props.href !== undefined) node.setAttribute('href', props.href);
  if (props.data) {
    for (const [key, value] of Object.entries(props.data)) node.setAttribute('data-' + key, value);
  }
  if (props.width !== undefined) node.style.width = props.width;
  if (props.hidden !== undefined) node.hidden = props.hidden;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'number' ? String(child) : child);
  }
  return node;
}

const creatureLine = element('creature-line');
const cards = element('overview-cards');
const environmentList = element('overview-environments');
const contextToggle = element<HTMLInputElement>('context-storage');
const contextHint = element('context-hint');

const feedingsBody = element('feedings-body');
const feedingsEmpty = element('feedings-empty');
const feedingsMore = element<HTMLButtonElement>('feedings-more');
const feedingsSearch = element<HTMLInputElement>('feedings-search');
const feedingsCount = element('feedings-count');
const sourceChips = element('source-chips');

const vocabList = element('vocab-list');
const vocabEmpty = element('vocab-empty');
const vocabMore = element<HTMLButtonElement>('vocab-more');
const vocabSearch = element<HTMLInputElement>('vocab-search');
const vocabSort = element<HTMLSelectElement>('vocab-sort');
const vocabEaten = element<HTMLInputElement>('vocab-eaten');
const vocabCount = element('vocab-count');
const wordDetail = element('word-detail');

type TabName = 'overview' | 'feedings' | 'vocabulary';

const tabs: Record<TabName, { button: HTMLButtonElement; view: HTMLElement }> = {
  overview: { button: element<HTMLButtonElement>('tab-overview'), view: element('view-overview') },
  feedings: { button: element<HTMLButtonElement>('tab-feedings'), view: element('view-feedings') },
  vocabulary: { button: element<HTMLButtonElement>('tab-vocabulary'), view: element('view-vocabulary') },
};

/* ------------------------------------------------------------------------- */
/* formatting                                                                 */
/* ------------------------------------------------------------------------- */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** "today", "yesterday", or a date - never a bare timestamp. */
function dayLabel(moment: number): string {
  if (!Number.isFinite(moment) || moment <= 0) return '—';
  const date = new Date(moment);
  const now = new Date();
  if (sameDay(date, now)) return 'today';
  if (sameDay(date, new Date(now.getTime() - 86_400_000))) return 'yesterday';
  return dateFormat.format(date);
}

function clock(moment: number): string {
  if (!Number.isFinite(moment) || moment <= 0) return '—';
  return timeFormat.format(new Date(moment));
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? '1 ' + one : count + ' ' + many;
}

/* ------------------------------------------------------------------------- */
/* messaging                                                                  */
/* ------------------------------------------------------------------------- */

async function ask<T>(query: JournalQuery): Promise<T | null> {
  const response = await sendRuntimeMessage<T>({ type: 'xrawl/journal', query });
  if (response === null || !response.ok) return null;
  return response.data;
}

/* ------------------------------------------------------------------------- */
/* overview                                                                   */
/* ------------------------------------------------------------------------- */

function card(value: string, label: string, ...notes: Child[]): HTMLElement {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-value', text: value }),
    h('div', { class: 'card-label', text: label }),
    ...notes,
  ]);
}

function renderOverview(data: JournalOverview): void {
  creatureLine.textContent = [data.creatureName, data.species, data.stage, 'level ' + data.level].join(' · ');

  const pressed = data.levelSpan > 0 ? Math.min(1, data.intoLevel / data.levelSpan) : 1;
  const levelNote =
    data.levelSpan > 0
      ? data.intoLevel + ' / ' + data.levelSpan + ' xp · ' + data.xpForNextLevel + ' to go'
      : 'max level';

  const levelBar = h('div', { class: 'xp-bar' }, [
    h('div', { class: 'xp-fill', width: (pressed * 100).toFixed(1) + '%' }),
  ]);

  cards.replaceChildren(
    card(String(data.wordsConsumed), 'words consumed', h('div', {
      class: 'card-note',
      text: plural(data.manualFeedings, 'manual feeding', 'manual feedings'),
    })),
    card(String(data.uniqueConsumed), 'unique vocabulary', h('div', {
      class: 'card-note',
      text: data.uniqueDiscovered + ' words seen in total',
    })),
    card(String(data.level), 'level · ' + data.stage, levelBar, h('div', {
      class: 'card-note',
      text: levelNote,
    })),
    card(String(data.wordPoints), 'word points', h('div', {
      class: 'card-note',
      text: data.lifetimeWordPoints + ' earned in total',
    })),
    card(String(data.wordsPerMinute), 'words / minute', h('div', {
      class: 'card-note',
      text: data.activeMinutes + ' min of focused browsing',
    })),
    card(dayLabel(data.firstFeedingAt), 'first feeding', h('div', {
      class: 'card-note',
      text: 'last: ' + dayLabel(data.lastFeedingAt),
    })),
  );

  if (data.environments.length === 0) {
    environmentList.replaceChildren(
      h('p', { class: 'hint', text: 'No browsing time recorded yet.' }),
    );
  } else {
    environmentList.replaceChildren(
      ...data.environments.map((site) =>
        h('div', { class: 'env-row' }, [
          h('div', {}, [
            h('div', { class: 'env-name', text: site.label }),
            h('div', { class: 'env-host mono', text: site.host }),
          ]),
          h('div', { class: 'env-bar' }, [
            h('div', { class: 'env-fill', width: Math.max(1, Math.round(site.share * 100)) + '%' }),
          ]),
          h('div', { class: 'env-minutes', text: site.exposureMinutes + ' min' }),
        ]),
      ),
    );
  }

  contextToggle.checked = data.contextStorage;
  renderContextHint(data.contextStorage);
}

function renderContextHint(enabled: boolean): void {
  contextHint.textContent = enabled
    ? 'Sentences are stored with each feeding and listed in the word detail. The vector is built from them at learn time either way.'
    : 'Only a hash of the sentence is stored. The contextual vector is built in memory and the passage is discarded.';
}

/* ------------------------------------------------------------------------- */
/* feeding history                                                            */
/* ------------------------------------------------------------------------- */

interface FeedingState {
  entries: JournalFeedingsPage['entries'][number][];
  source: 'all' | 'manual' | 'autonomous';
  term: string;
  total: number;
  hasMore: boolean;
}

const feedingState: FeedingState = {
  entries: [],
  source: 'all',
  term: '',
  total: 0,
  hasMore: false,
};

function safeUrl(url: string): string | null {
  return url.startsWith('https://') || url.startsWith('http://') ? url : null;
}

function pageCell(entry: FeedingState['entries'][number]): HTMLElement {
  const url = safeUrl(entry.pageUrl);
  const title = entry.pageTitle || entry.host;
  if (url === null) return h('span', { class: 'sub', text: title });

  const link = h('a', { class: 'sub', href: url, title: entry.pageUrl, text: title });
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noreferrer noopener');
  return link;
}

function rewardCell(entry: FeedingState['entries'][number]): HTMLElement[] {
  if (entry.points <= 0) {
    return [h('span', { class: 'reward unknown', text: '—' }), h('span', { class: 'sub', text: 'before v7' })];
  }
  return [
    h('span', { class: 'reward', text: entry.points + ' wp' }),
    h('span', { class: 'sub', text: entry.xp + ' xp' }),
  ];
}

function renderFeedings(): void {
  feedingsBody.replaceChildren(
    ...feedingState.entries.map((entry) =>
      h('tr', {}, [
        h('td', { class: 'word-cell' }, [
          h('button', { type: 'button', data: { word: entry.word }, text: entry.word }),
        ]),
        h('td', {}, [
          h('span', { text: clock(entry.eatenAt) }),
          h('span', { class: 'sub', text: dayLabel(entry.eatenAt) }),
        ]),
        h('td', {}, [h('span', { class: 'mono', text: entry.host })]),
        h('td', {}, [pageCell(entry)]),
        h('td', {}, [
          h('span', {
            class: 'tag ' + entry.source,
            text: entry.source === 'manual' ? 'Manual' : 'Autonomous',
          }),
          h('span', { class: 'sub', text: environmentLabel(entry.environment) }),
        ]),
        h('td', { class: 'num' }, rewardCell(entry)),
      ]),
    ),
  );

  feedingsEmpty.hidden = feedingState.entries.length > 0;
  feedingsMore.hidden = !feedingState.hasMore;
  feedingsCount.textContent =
    feedingState.total === 0
      ? 'nothing recorded'
      : feedingState.entries.length + ' of ' + feedingState.total + ' entries';
}

async function loadFeedings(reset: boolean): Promise<void> {
  const offset = reset ? 0 : feedingState.entries.length;
  const term = feedingState.term.trim();

  const query: MutableQuery<JournalFeedingsQuery> = {
    view: 'feedings',
    limit: PAGE_SIZE,
    offset,
  };
  if (feedingState.source !== 'all') query.source = feedingState.source;
  // Anything with a dot is a site; everything else is a word.
  if (term.length > 0) {
    if (term.includes('.')) query.host = term;
    else query.word = term;
  }

  const page = await ask<JournalFeedingsPage>(query);
  if (page === null) {
    feedingsCount.textContent = 'history unavailable';
    return;
  }

  feedingState.entries = reset ? page.entries.slice() : feedingState.entries.concat(page.entries);
  feedingState.total = page.total;
  feedingState.hasMore = page.hasMore;
  renderFeedings();
}

/* ------------------------------------------------------------------------- */
/* vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

interface VocabularyState {
  entries: JournalWord[];
  sort: 'eaten' | 'recent' | 'alpha';
  search: string;
  eatenOnly: boolean;
  total: number;
  hasMore: boolean;
  selected: string | null;
}

const vocabularyState: VocabularyState = {
  entries: [],
  sort: 'eaten',
  search: '',
  eatenOnly: false,
  total: 0,
  hasMore: false,
  selected: null,
};

function renderVocabulary(): void {
  vocabList.replaceChildren(
    ...vocabularyState.entries.map((word) =>
      h('li', {}, [
        h('button', {
          type: 'button',
          data: { word: word.word, selected: String(vocabularyState.selected === word.word) },
        }, [
          h('span', { class: 'vocab-word', text: word.word }),
          h('span', {
            class: 'vocab-meta',
            text: word.timesEaten > 0 ? plural(word.timesEaten, 'eaten', 'eaten') : 'never eaten',
          }),
          h('span', { class: 'vocab-meta', text: 'seen ' + word.timesSeen }),
          h('span', {
            class: 'vocab-meta',
            text: dayLabel(word.lastEatenAt > 0 ? word.lastEatenAt : word.lastSeenAt),
          }),
        ]),
      ]),
    ),
  );

  vocabEmpty.hidden = vocabularyState.entries.length > 0;
  vocabMore.hidden = !vocabularyState.hasMore;
  vocabCount.textContent =
    vocabularyState.total === 0
      ? 'no words'
      : vocabularyState.entries.length + ' of ' + vocabularyState.total + ' words';
}

async function loadVocabulary(reset: boolean): Promise<void> {
  const offset = reset ? 0 : vocabularyState.entries.length;
  const search = vocabularyState.search.trim();

  const query: MutableQuery<JournalVocabularyQuery> = {
    view: 'vocabulary',
    limit: PAGE_SIZE,
    offset,
    sort: vocabularyState.sort,
    filter: vocabularyState.eatenOnly ? 'eaten' : 'all',
  };
  if (search.length > 0) query.search = search;

  const page = await ask<JournalVocabularyPage>(query);
  if (page === null) {
    vocabCount.textContent = 'vocabulary unavailable';
    return;
  }

  vocabularyState.entries = reset ? page.entries.slice() : vocabularyState.entries.concat(page.entries);
  vocabularyState.total = page.total;
  vocabularyState.hasMore = page.hasMore;
  renderVocabulary();
  markSelected(vocabularyState.selected);
}

function markSelected(word: string | null): void {
  vocabularyState.selected = word;
  for (const button of vocabList.querySelectorAll<HTMLButtonElement>('button[data-word]')) {
    button.dataset.selected = String(button.dataset.word === word);
  }
}

function factGrid(facts: ReadonlyArray<readonly [string, string]>): HTMLElement {
  return h(
    'div',
    { class: 'stat-grid' },
    facts.flatMap(([label, value]) => [h('span', { text: label }), h('b', { text: value })]),
  );
}

function renderWordDetail(detail: JournalWordDetail | null, word: string | null): void {
  if (word === null) {
    wordDetail.hidden = true;
    wordDetail.replaceChildren();
    return;
  }

  wordDetail.hidden = false;
  if (detail === null) {
    wordDetail.replaceChildren(h('p', { class: 'hint', text: 'Could not load this word.' }));
    return;
  }

  const item = detail.word;
  const facts: Array<readonly [string, string]> = [
    ['eaten', item.timesEaten > 0 ? item.timesEaten + 'x' : 'never'],
    ['seen', item.timesSeen + 'x'],
    ['first eaten', item.firstEatenAt > 0 ? dayLabel(item.firstEatenAt) + ' · ' + clock(item.firstEatenAt) : '—'],
    ['last eaten', item.lastEatenAt > 0 ? dayLabel(item.lastEatenAt) + ' · ' + clock(item.lastEatenAt) : '—'],
    ['first seen', item.firstSeenAt > 0 ? dayLabel(item.firstSeenAt) : '—'],
    ['last seen', item.lastSeenAt > 0 ? dayLabel(item.lastSeenAt) : '—'],
  ];

  const environments = Object.entries(item.environments)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => right[1] - left[1]);

  const children: Child[] = [h('h2', { text: detail.word.word }), factGrid(facts)];

  if (environments.length > 0) {
    children.push(
      h('h3', { text: 'seen in' }),
      h(
        'div',
        { class: 'chip-list' },
        environments.map(([kind, count]) =>
          h('span', { class: 'tag', text: environmentLabel(kind) + ' ' + count }),
        ),
      ),
    );
  }

  if (detail.hosts.length > 0) {
    children.push(
      h('h3', { text: 'sites' }),
      h(
        'div',
        { class: 'chip-list' },
        detail.hosts.map((host) => h('button', { type: 'button', data: { host }, text: host })),
      ),
    );
  }

  children.push(
    h('h3', {
      text: 'related words · ' + (detail.model === null ? 'same sites' : detail.model),
    }),
    detail.related.length > 0
      ? h(
          'div',
          { class: 'chip-list' },
          detail.related.map((neighbour) =>
            h('button', { type: 'button', data: { word: neighbour.word } }, [
              neighbour.word,
              h('span', { class: 'sim', text: neighbour.similarity.toFixed(2) }),
            ]),
          ),
        )
      : h('p', {
          class: 'hint',
          text: 'No neighbours yet: this word has no cached vector and no shared site.',
        }),
    h('h3', { text: 'recent feedings' }),
    detail.feedings.length > 0
      ? h(
          'div',
          { class: 'mini-feedings' },
          detail.feedings.slice(0, 12).map((feeding) =>
            h('div', { class: 'mini-row' }, [
              h('span', { class: 'word', text: feeding.host }),
              h('span', { text: clock(feeding.eatenAt) + ' · ' + dayLabel(feeding.eatenAt) }),
              h('span', { text: feeding.source === 'manual' ? 'manual' : 'auto' }),
            ]),
          ),
        )
      : h('p', { class: 'hint', text: item.timesEaten > 0 ? 'No feedings recorded.' : 'Never eaten.' }),
  );

  if (detail.contexts.length > 0) {
    children.push(
      h('h3', { text: 'stored context' }),
      h(
        'div',
        { class: 'mini-feedings' },
        detail.contexts.map((snippet) =>
          h('div', { class: 'mini-row' }, [
            h('span', { class: 'word', text: dayLabel(snippet.eatenAt) }),
            h('span', { class: 'sub wide', text: snippet.sentence }),
          ]),
        ),
      ),
    );
  }

  wordDetail.replaceChildren(...nodesOf(children));
}

async function openWord(word: string): Promise<void> {
  showTab('vocabulary');
  markSelected(word);
  wordDetail.hidden = false;
  wordDetail.replaceChildren(h('p', { class: 'hint', text: 'Loading ' + word + '…' }));
  const detail = await ask<JournalWordDetail>({ view: 'word', word });
  if (vocabularyState.selected !== word) return;
  renderWordDetail(detail, word);
}

/* ------------------------------------------------------------------------- */
/* tabs and events                                                            */
/* ------------------------------------------------------------------------- */

function showTab(name: TabName): void {
  for (const key of Object.keys(tabs) as TabName[]) {
    const active = key === name;
    tabs[key].button.dataset.on = String(active);
    tabs[key].view.hidden = !active;
  }
}

function debounce(task: () => void, ms: number): () => void {
  let timer = 0;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(task, ms);
  };
}

for (const key of Object.keys(tabs) as TabName[]) {
  tabs[key].button.addEventListener('click', () => showTab(key));
}

sourceChips.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.source) return;
  const source = target.dataset.source;
  if (source !== 'all' && source !== 'manual' && source !== 'autonomous') return;
  feedingState.source = source;
  for (const chip of sourceChips.querySelectorAll('button')) {
    chip.dataset.on = String(chip.dataset.source === source);
  }
  void loadFeedings(true);
});

const refreshFeedings = debounce(() => {
  feedingState.term = feedingsSearch.value;
  void loadFeedings(true);
}, 250);
feedingsSearch.addEventListener('input', refreshFeedings);
feedingsMore.addEventListener('click', () => void loadFeedings(false));

const refreshVocabulary = debounce(() => {
  vocabularyState.search = vocabSearch.value;
  void loadVocabulary(true);
}, 250);
vocabSearch.addEventListener('input', refreshVocabulary);
vocabSort.addEventListener('change', () => {
  const value = vocabSort.value;
  vocabularyState.sort = value === 'alpha' || value === 'recent' ? value : 'eaten';
  void loadVocabulary(true);
});
vocabEaten.addEventListener('change', () => {
  vocabularyState.eatenOnly = vocabEaten.checked;
  void loadVocabulary(true);
});
vocabMore.addEventListener('click', () => void loadVocabulary(false));

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const wordButton = target.closest<HTMLElement>('[data-word]');
  if (wordButton?.dataset.word) {
    void openWord(wordButton.dataset.word);
    return;
  }
  const hostButton = target.closest<HTMLElement>('[data-host]');
  if (hostButton?.dataset.host) {
    showTab('feedings');
    feedingsSearch.value = hostButton.dataset.host;
    feedingState.term = hostButton.dataset.host;
    void loadFeedings(true);
  }
});

contextToggle.addEventListener('change', () => {
  void (async () => {
    const response = await sendRuntimeMessage<JournalSettings>({
      type: 'xrawl/set-context-storage',
      enabled: contextToggle.checked,
    });
    if (response === null || !response.ok) {
      contextToggle.checked = !contextToggle.checked;
      contextHint.textContent = 'Could not save that preference.';
      return;
    }
    renderContextHint(response.data.contextStorage);
  })();
});

/* ------------------------------------------------------------------------- */
/* boot                                                                       */
/* ------------------------------------------------------------------------- */

void (async () => {
  const overview = await ask<JournalOverview>({ view: 'overview' });
  if (overview === null) {
    creatureLine.textContent = 'journal unavailable — open the extension once to start the background.';
    return;
  }
  renderOverview(overview);
  await Promise.all([loadFeedings(true), loadVocabulary(true)]);
})();
