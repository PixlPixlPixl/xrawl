/**
 * Architecture guards.
 *
 * The whole reason persistence lives in the background is that Chrome content
 * scripts share the host page's origin: a content script that opened IndexedDB
 * would write into *the page's* storage, which page code can read. These tests
 * fail if that boundary erodes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function offenders(match: (specifier: string, file: string) => boolean): string[] {
  return sourceFiles(SRC)
    .filter((file) => importsOf(file).some((specifier) => match(specifier, file)))
    .map((file) => path.relative(SRC, file));
}

describe('persistence boundary', () => {
  it('lets only the data layer import Dexie', () => {
    const files = offenders((specifier) => specifier === 'dexie' || specifier.startsWith('dexie/'));
    expect(files.sort()).toEqual(['data/db.ts']);
  });

  it('keeps the database opener out of content-side code', () => {
    const files = offenders(
      (specifier, file) =>
        /^@\/data\/(db|service|export|ingest)(\.ts)?$/.test(specifier) &&
        !file.startsWith(path.join(SRC, 'entrypoints')),
    );
    expect(files).toEqual([]);
  });

  it('keeps engine and UI layers clear of browser-only persistence modules', () => {
    const files = offenders((specifier) =>
      specifier.startsWith('@/platform/browser/resilience'),
    );
    // Only the background worker may touch `browser.storage.local`.
    expect(files).toEqual(['entrypoints/background.ts']);
  });

  it('keeps the creature engine free of DOM and platform imports', () => {
    const engineFiles = offenders(
      (specifier, file) =>
        file.startsWith(path.join(SRC, 'creature')) &&
        /^(expo|wxt|dexie|@\/platform|@\/data|@\/ui|@\/app)/.test(specifier),
    );
    // `creature/` is the simulation: it must be reusable by a desktop host.
    expect(engineFiles).toEqual([]);
  });

  it('has no content-script import of IndexedDB-backed modules', () => {
    const contentSide = [
      path.join(SRC, 'app'),
      path.join(SRC, 'world'),
      path.join(SRC, 'ui'),
      path.join(SRC, 'entrypoints', 'content.ts'),
    ];
    const offendersInScope: string[] = [];
    for (const root of contentSide) {
      if (!statSync(root).isDirectory()) continue;
      for (const file of sourceFiles(root)) {
        if (importsOf(file).some((specifier) => specifier.startsWith('@/data/repositories'))) {
          offendersInScope.push(path.relative(SRC, file));
        }
      }
    }
    expect(offendersInScope).toEqual([]);
  });
});
