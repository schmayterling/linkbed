import { publicUrl } from './metadata.ts';
import { normalizeCustomBadges } from './public/model.mts';
import type { CustomBadge } from './public/model.mts';

export function validateCustomBadges(value: unknown): CustomBadge[] {
  const badges = normalizeCustomBadges(value);
  for (const badge of badges) publicUrl(badge.image, 'badge image url');
  return badges;
}

export function readCustomBadges(value: string | null): CustomBadge[] {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    return validateCustomBadges(parsed);
  } catch {
    return [];
  }
}
