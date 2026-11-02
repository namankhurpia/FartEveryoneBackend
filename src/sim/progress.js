// Level unlocking. For now every level is open; set LEVELS_LOCKED to true to go back to
// "finishing a level opens the next one". `cleared` is a set (or array) of finished level ids.
import { RACE_LEVELS } from './levels.js';

export const LEVELS_LOCKED = false;

export function unlockedLevels(cleared) {
  if (!LEVELS_LOCKED) return [...RACE_LEVELS];
  const done = new Set(cleared);
  return RACE_LEVELS.filter((id, i) => i === 0 || done.has(RACE_LEVELS[i - 1]));
}
