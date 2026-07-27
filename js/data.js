// Public data entry point. The open-source edition intentionally ships only
// the original APEX championship; no real-world team, driver, or sponsor data
// is bundled in this repository.
export {
  SEASON, TEAMS, DRIVERS, CALENDAR, POINTS, REGS_2026,
} from './data-fictional.js';

// Retained for compatibility with existing APEX championship saves.
export const STORAGE_SUFFIX = '_apex';
