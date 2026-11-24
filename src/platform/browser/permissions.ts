/**
 * Permission helpers for capabilities that will be requested lazily as the
 * game grows (e.g. optional host access for non-injected tabs).
 *
 * Not wired into the debug tool yet — the content script covers the pages we
 * need. Kept here so permission prompts never leak into engine code.
 */
import { browser } from '#imports';

type PermissionSet = Parameters<typeof browser.permissions.request>[0];

function toPermissionSet(permissions: string[]): PermissionSet {
  // SAFETY: the ambient ManifestPermission type is a closed union of every
  // permission this extension could declare, while the caller supplies names
  // from our own config. The browser validates unknown names at request time.
  return { permissions } as unknown as PermissionSet;
}

export async function hasPermissions(permissions: string[]): Promise<boolean> {
  try {
    return (await browser.permissions.contains(toPermissionSet(permissions))) === true;
  } catch {
    return false;
  }
}

export async function requestPermissions(permissions: string[]): Promise<boolean> {
  try {
    return (await browser.permissions.request(toPermissionSet(permissions))) === true;
  } catch {
    return false;
  }
}
