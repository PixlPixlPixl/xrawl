import type { XrawlDatabase } from '../db';
import type { UpgradeRecord } from '../schema';

export async function getUpgrade(db: XrawlDatabase, id: string): Promise<UpgradeRecord | undefined> {
  return db.upgrades.get(id);
}

export async function listUpgrades(db: XrawlDatabase): Promise<UpgradeRecord[]> {
  return db.upgrades.orderBy('updatedAt').reverse().toArray();
}

/**
 * Purchase or upgrade. Read-modify-write inside one transaction so concurrent
 * purchases cannot both see level 1 and each buy level 2.
 */
export async function purchaseUpgrade(
  db: XrawlDatabase,
  id: string,
  options: { readonly cost: number; readonly now: number; readonly maxLevel?: number },
): Promise<UpgradeRecord> {
  return db.transaction('rw', db.upgrades, async () => {
    const existing = await db.upgrades.get(id);
    if (existing) {
      if (options.maxLevel !== undefined && existing.level >= options.maxLevel) {
        throw new Error(`Upgrade ${id} is already at max level ${options.maxLevel}`);
      }
      const updated: UpgradeRecord = {
        ...existing,
        level: existing.level + 1,
        updatedAt: options.now,
        totalSpent: existing.totalSpent + options.cost,
      };
      await db.upgrades.put(updated);
      return updated;
    }

    const created: UpgradeRecord = {
      id,
      level: 1,
      purchasedAt: options.now,
      updatedAt: options.now,
      totalSpent: options.cost,
      meta: {},
    };
    await db.upgrades.add(created);
    return created;
  });
}

/** Level lookup for game math; 0 when never purchased. */
export async function upgradeLevel(db: XrawlDatabase, id: string): Promise<number> {
  const record = await db.upgrades.get(id);
  return record?.level ?? 0;
}

