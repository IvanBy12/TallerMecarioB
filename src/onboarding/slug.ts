import { randomBytes } from 'node:crypto';

const SLUG_MAX_LENGTH = 80;
const RANDOM_COMPONENT_LENGTH = 12;

/** Server-owned, ASCII-stable slug with a random collision-resistant suffix. */
export function createWorkshopSlug(displayName: string): string {
  const normalized = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  const base = normalized || 'taller';
  const suffix = randomBytes(RANDOM_COMPONENT_LENGTH / 2).toString('hex');
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length - 1).replace(/-+$/u, '')}-${suffix}`;
}
