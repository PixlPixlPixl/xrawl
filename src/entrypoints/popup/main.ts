import './style.css';
import { getActiveTab, onRuntimeMessage, sendRuntimeMessage, sendTabMessage } from '@/platform/browser/messaging';
import { isExportEnvelope } from '@/data/export-format';
import type { XrawlExportEnvelope } from '@/data/export-format';
import { isStatsBroadcast } from '@/shared/types/messaging';
import type {
  DatabaseStatusPayload,
  DownloadResult,
  ExportPayload,
  StatusPayload,
  UpgradePurchasePayload,
} from '@/shared/types/messaging';

function elementById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Popup element #${id} is missing`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Popup button #${id} is missing`);
  return element;
}

const pageTitle = elementById('page-title');
const pageUrl = elementById('page-url');
const environment = elementById('env');
const statTargets = elementById('stat-targets');
const statUnique = elementById('stat-unique');
const statVisible = elementById('stat-visible');
const statRects = elementById('stat-rects');
const meta = elementById('meta');
const topWords = elementById('top-words');
const message = elementById('message');
const error = elementById('error');

const toggleButton = buttonById('toggle');
const rescanButton = buttonById('rescan');
const copyButton = buttonById('copy');
const downloadButton = buttonById('download');
const actionButtons = [toggleButton, rescanButton, copyButton, downloadButton];

const dbVersion = elementById('db-version');
const dbCounts = elementById('db-counts');
const dbInterests = elementById('db-interests');
const dbHint = elementById('db-hint');
const dbExportButton = buttonById('db-export');
const dbImportInput = document.getElementById('db-import-input');
const upgradeList = elementById('upgrade-list');
const wpBalance = elementById('wp-balance');

let tabId: number | null = null;
let lastStatus: StatusPayload | null = null;
let messageTimer: number | null = null;

function setActionsEnabled(enabled: boolean): void {
  for (const button of actionButtons) button.disabled = !enabled;
}

function showMessage(text: string): void {
  message.textContent = text;
  if (messageTimer !== null) window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    messageTimer = null;
    message.textContent = '';
  }, 4_000);
}

function showError(text: string): void {
  error.textContent = text;
  error.dataset.show = 'true';
}

function clearError(): void {
  error.dataset.show = 'false';
  error.textContent = '';
}

function renderTopWords(words: StatusPayload['stats']['topWords']): void {
  topWords.replaceChildren();
  if (words.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no words discovered yet';
    topWords.append(empty);
    return;
  }

  for (const entry of words) {
    const item = document.createElement('li');
    const word = document.createElement('span');
    word.textContent = entry.word;
    const count = document.createElement('b');
    count.textContent = String(entry.count);
    item.append(word, count);
    topWords.append(item);
  }
}

function renderStatus(status: StatusPayload): void {
  lastStatus = status;
  clearError();
  setActionsEnabled(true);

  const stats = status.stats;
  pageTitle.textContent = status.page.title || '(untitled page)';
  pageUrl.textContent = status.page.url;
  pageUrl.title = status.page.url;

  const confidence =
    status.environment.kind === 'unknown'
      ? 'no signals'
      : `${Math.round(status.environment.confidence * 100)}% confidence`;
  environment.textContent = `${status.environment.kind} \u00b7 ${confidence}`;
  environment.title = status.environment.reasons.join(', ');

  statTargets.textContent = String(stats.targetCount);
  statUnique.textContent = String(stats.uniqueWordCount);
  statVisible.textContent = String(stats.visibleInViewport);
  statRects.textContent = String(stats.rectCount);

  const segmentation = stats.segmentation;
  const segmentationTotal = segmentation.hits + segmentation.misses;
  const cacheRate =
    segmentationTotal > 0 ? Math.round((segmentation.hits / segmentationTotal) * 100) : 0;

  const metaParts = [
    `${stats.lastPassKind} pass ${Math.round(stats.lastPassDurationMs)}ms`,
    `${stats.lastPassNodeCount} nodes`,
    `seg cache ${cacheRate}% (${segmentation.cacheSize})`,
    stats.lastPassLimited ? 'capped' : null,
    new Date(status.capturedAt).toLocaleTimeString(),
  ].filter((part): part is string => part !== null);
  meta.textContent = metaParts.join(' \u00b7 ');

  renderTopWords(stats.topWords);

  toggleButton.textContent = status.overlayVisible ? 'outlines on' : 'outlines off';
  toggleButton.dataset.on = String(status.overlayVisible);
}

function renderOffline(title: string): void {
  lastStatus = null;
  setActionsEnabled(false);
  pageTitle.textContent = title;
  pageUrl.textContent = '';
  environment.textContent = '';
  statTargets.textContent = '0';
  statUnique.textContent = '0';
  statVisible.textContent = '0';
  statRects.textContent = '0';
  meta.textContent = '\u2014';
  renderTopWords([]);
  toggleButton.textContent = 'offline';
  toggleButton.dataset.on = 'false';
  showError(
    'Xrawl is not running on this tab. Reload the page (or install/enable the extension), then reopen this popup.',
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be blocked in some popup states; fall back to a
    // hidden textarea + execCommand.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function load(): Promise<void> {
  const tab = await getActiveTab();
  if (tab === null || tab.id === undefined) {
    renderOffline('No active tab');
    return;
  }

  tabId = tab.id;
  const response = await sendTabMessage<StatusPayload>(tabId, { type: 'xrawl/get-stats' });
  if (response?.ok) {
    renderStatus(response.data);
    return;
  }

  // Content script not reachable (extension just reloaded, or the page is
  // outside the injected host range). Try the background's last cache.
  const cached = await sendRuntimeMessage<StatusPayload | null>({
    type: 'xrawl/get-cached-stats',
    tabId,
  });
  if (cached?.ok && cached.data) {
    renderStatus(cached.data);
    showMessage('Showing cached stats \u2014 reload the page for the live scan.');
    return;
  }

  renderOffline('Xrawl is offline on this tab');
}

toggleButton.addEventListener('click', () => {
  if (tabId === null) return;
  const visible = lastStatus === null ? true : !lastStatus.overlayVisible;
  void sendTabMessage<StatusPayload>(tabId, { type: 'xrawl/set-overlay', visible }).then((response) => {
    if (response?.ok) renderStatus(response.data);
    else renderOffline('Xrawl is offline on this tab');
  });
});

rescanButton.addEventListener('click', () => {
  if (tabId === null) return;
  showMessage('Rescanning\u2026');
  void sendTabMessage<StatusPayload>(tabId, { type: 'xrawl/rescan' }).then((response) => {
    if (response?.ok) {
      renderStatus(response.data);
      showMessage('Rescan complete.');
    } else {
      renderOffline('Xrawl is offline on this tab');
    }
  });
});

copyButton.addEventListener('click', () => {
  if (tabId === null) return;
  void sendTabMessage<ExportPayload>(tabId, { type: 'xrawl/get-snapshot' }).then(async (response) => {
    if (!response?.ok) {
      renderOffline('Xrawl is offline on this tab');
      return;
    }

    const payload = response.data;
    const json = JSON.stringify(payload, null, 2);
    const copied = await copyText(json);
    if (!copied) {
      showMessage('Clipboard blocked \u2014 use Download instead.');
      return;
    }
    const truncation = payload.truncated ? ` (capped at ${payload.exportedTargetCount})` : '';
    showMessage(`Copied ${payload.exportedTargetCount} targets${truncation} \u2014 ${json.length} bytes.`);
  });
});

downloadButton.addEventListener('click', () => {
  if (tabId === null) return;
  void sendTabMessage<DownloadResult>(tabId, { type: 'xrawl/download-snapshot' }).then((response) => {
    if (!response?.ok) {
      renderOffline('Xrawl is offline on this tab');
      return;
    }
    const result = response.data;
    const truncation = result.truncated ? ` (capped at ${result.count})` : '';
    showMessage(`Downloaded ${result.count} targets${truncation} \u2014 ${result.bytes} bytes.`);
  });
});

/* ------------------------------------------------------------------ */
/* World memory (background-owned database)                           */
/* ------------------------------------------------------------------ */

function renderDatabaseStatus(status: DatabaseStatusPayload | null): void {
  if (status === null) {
    dbVersion.textContent = '';
    dbCounts.textContent = 'not available';
    dbInterests.textContent = '';
    wpBalance.textContent = '';
    upgradeList.replaceChildren();
    return;
  }

  const { progression } = status;
  const topAffinity = Object.entries(progression.affinities).sort((left, right) => right[1]! - left[1]!)[0];
  const affinityText =
    topAffinity === undefined
      ? ''
      : ` \u00b7 ${topAffinity[0]} ${Math.round(topAffinity[1]! * 100)}%`;

  dbVersion.textContent = `v${status.schemaVersion}`;
  dbCounts.textContent = `${status.vocabularyCount} words \u00b7 ${status.feedingCount} feedings \u00b7 lv ${progression.level} \u00b7 ${progression.xp} xp${affinityText}`;
  wpBalance.textContent = `${progression.wordPoints} wp`;

  const semantics = status.semantics;
  const learnt =
    semantics.profiles.length > 0
      ? semantics.profiles
          .map((profile) => `${profile.category} ${Math.round(profile.share * 100)}%`)
          .join(' \u00b7 ')
      : 'nothing yet';
  dbInterests.textContent = `Interests: ${learnt} \u00b7 model ${semantics.state}`;
  renderUpgrades(status.upgrades);
}

/**
 * The upgrade shop.
 *
 * Rendering is dumb on purpose: affordability and prices come from the
 * background, which owns the balance, so the popup never guesses and never
 * shows a button that would fail.
 */
function renderUpgrades(upgrades: DatabaseStatusPayload['upgrades']): void {
  upgradeList.replaceChildren();

  if (upgrades.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no upgrades available';
    upgradeList.append(empty);
    return;
  }

  for (const upgrade of upgrades) {
    const row = document.createElement('div');
    row.className = 'upgrade-row';

    const name = document.createElement('div');
    name.className = 'upgrade-name';
    name.textContent = `${upgrade.name} ${upgrade.level}/${upgrade.maxLevel}`;

    const description = document.createElement('div');
    description.className = 'upgrade-description';
    description.textContent = upgrade.description;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upgrade-buy';
    button.dataset.upgradeId = upgrade.id;
    const maxed = upgrade.level >= upgrade.maxLevel;
    button.textContent = maxed ? 'max' : `${upgrade.nextCost} wp`;
    button.disabled = maxed || !upgrade.affordable;

    row.append(name, description, button);
    upgradeList.append(row);
  }
}

const PURCHASE_FAILURE_TEXT: Record<string, string> = {
  'unknown-upgrade': 'That upgrade does not exist.',
  'max-level': 'Already at max level.',
  'insufficient-points': 'Not enough word points yet.',
};

upgradeList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-upgrade-id]');
  if (!(button instanceof HTMLButtonElement) || !button.dataset.upgradeId) return;

  const upgradeId = button.dataset.upgradeId;
  button.disabled = true;

  void sendRuntimeMessage<UpgradePurchasePayload>({ type: 'xrawl/purchase-upgrade', upgradeId }).then(
    async (response) => {
      if (!response?.ok) {
        showError(`Purchase failed: ${response?.error ?? 'no background worker'}`);
        return;
      }

      const result = response.data;
      if (result.purchased) {
        showMessage(`Bought ${upgradeId} level ${result.level} for ${result.cost} wp.`);
      } else {
        showMessage(PURCHASE_FAILURE_TEXT[result.reason ?? ''] ?? 'Purchase rejected.');
      }

      await refreshDatabase();
    },
  );
});

function describeBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

async function refreshDatabase(): Promise<void> {
  const status = await sendRuntimeMessage<DatabaseStatusPayload>({ type: 'xrawl/db-status' });
  if (!status?.ok) {
    renderDatabaseStatus(null);
    return;
  }
  renderDatabaseStatus(status.data);

  if (status.data.storage) {
    const { usage, quota, persisted } = status.data.storage;
    dbHint.textContent = `${describeBytes(usage)} of ${describeBytes(quota)}${persisted ? ' \u00b7 persistent' : ''}`;
  } else {
    dbHint.textContent = '';
  }
}

dbExportButton.addEventListener('click', () => {
  void (async () => {
    const response = await sendRuntimeMessage<XrawlExportEnvelope>({ type: 'xrawl/db-export' });
    if (!response?.ok) {
      showError(`Export failed: ${response?.error ?? 'no background worker'}`);
      return;
    }

    const envelope = response.data;
    const json = JSON.stringify(envelope, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `xrawl-world-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const words = envelope.counts.vocabulary ?? 0;
    showMessage(`Exported ${words} words \u2014 ${describeBytes(json.length)}.`);
  })();
});

async function importWorld(file: File): Promise<void> {
  clearError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showError('That file is not valid JSON.');
    return;
  }

  if (!isExportEnvelope(parsed)) {
    showError('That file is not a Xrawl world export.');
    return;
  }

  const words = parsed.counts?.vocabulary ?? 0;
  const confirmed = window.confirm(
    `Replace the current world with this export (${words} words)? This cannot be undone.`,
  );
  if (!confirmed) return;

  const response = await sendRuntimeMessage<{ imported: Record<string, number> }>({
    type: 'xrawl/db-import',
    envelope: parsed,
  });
  if (!response?.ok) {
    showError(`Import failed: ${response?.error ?? 'no background worker'}`);
    return;
  }

  await refreshDatabase();
  showMessage(`Imported ${response.data.imported.vocabulary ?? 0} words.`);
}

dbImportInput?.addEventListener('change', () => {
  if (!(dbImportInput instanceof HTMLInputElement)) return;
  const file = dbImportInput.files?.[0];
  if (file) void importWorld(file);
  dbImportInput.value = '';
});

onRuntimeMessage((incoming) => {
  if (!isStatsBroadcast(incoming) || incoming.tabId !== tabId) return;
  renderStatus(incoming.payload);
});

void load();
void refreshDatabase();
