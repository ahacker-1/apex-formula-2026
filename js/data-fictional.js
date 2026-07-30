// APEX FORMULA 2026 — original (fictional) roster. This is the PUBLIC default.
//
// Everything in this file is invented: teams, liveries, engine marques, drivers,
// event names and circuit names. Nothing here references, resembles or is derived
// from any real championship, team, driver, sponsor or circuit. It is the dataset
// that ships in a public build.
//
// Every consumer imports this schema through js/data.js. CALENDAR[].circuitName
// is the invented venue name used by the menus.
//
// perf / pace / consistency / racecraft are pure game-design ratings.

export const SEASON = 2026;

export const TEAMS = [
  // color/accent: invented liveries. perf: 0.90-0.99 relative car performance —
  // a balanced spread so the fictional grid remains competitive.
  { id: 'vantara',    name: 'Vantara',                 fullName: 'Vantara Racing Collective',            engine: 'Kestrel',  color: 0x7B2FF7, accent: 0xFFD200, perf: 0.99 },
  // TACN's deep blue-charcoal + electric azure is intentionally authored as a
  // racing livery, not pure black/white chrome. The cool off-black keeps its
  // body shape in night lighting while the saturated accent remains distinct
  // from every other team at chase-camera distance.
  { id: 'tacn',       name: 'AI Consulting Network',   fullName: 'The AI Consulting Network Racing Team', engine: 'Apex',     color: 0x111C2E, accent: 0x16C7FF, perf: 0.97 },
  { id: 'solaris',    name: 'Solaris',                 fullName: 'Solaris Racing Works',                 engine: 'Solstice', color: 0xFF4D1F, accent: 0x141414, perf: 0.96 },
  { id: 'meridian',   name: 'Meridian',                fullName: 'Meridian Motorsport Group',            engine: 'Volta',    color: 0x00A86B, accent: 0xF4F4F4, perf: 0.96 },
  { id: 'halcyon',    name: 'Halcyon',                 fullName: 'Halcyon Racing Division',              engine: 'Kestrel',  color: 0x2277CC, accent: 0xEAF4FF, perf: 0.95 },
  { id: 'norvik',     name: 'Norvik',                  fullName: 'Norvik Motorsport',                    engine: 'Volta',    color: 0x0E3B4F, accent: 0x62D6C8, perf: 0.94 },
  { id: 'ironwood',   name: 'Ironwood',                fullName: 'Ironwood Racing Company',              engine: 'Solstice', color: 0x9A6320, accent: 0xEBDCB2, perf: 0.93 },
  { id: 'kuroshio',   name: 'Kuroshio',                fullName: 'Kuroshio Racing Syndicate',            engine: 'Aeon',     color: 0x232A9E, accent: 0xFF5A8A, perf: 0.92 },
  { id: 'zephyr',     name: 'Zephyr',                  fullName: 'Zephyr Aero Racing',                   engine: 'Aeon',     color: 0xB5D400, accent: 0x102418, perf: 0.92 },
  { id: 'sablewood',  name: 'Sablewood',               fullName: 'Sablewood Racing Stable',              engine: 'Apex',     color: 0x6E1B32, accent: 0xD8B4C4, perf: 0.91 },
  { id: 'stonehaven', name: 'Stonehaven',              fullName: 'Stonehaven Racing Group',              engine: 'Solstice', color: 0x5A6672, accent: 0xFF7A29, perf: 0.90 },
];

export const DRIVERS = [
  // 22 invented drivers, two per team. Numbers are unique and were chosen so
  // stable across saved championships.
  { id: 'hacker',       code: 'AVI', num: 26, firstName: 'Avi',    lastName: 'Hacker',        team: 'tacn',       country: 'USA', pace: 0.97, consistency: 0.94, racecraft: 0.95 },
  { id: 'marchetti',    code: 'MAR', num: 7,  firstName: 'Ines',   lastName: 'Marchetti',     team: 'tacn',       country: 'ITA', pace: 0.94, consistency: 0.92, racecraft: 0.92 },
  { id: 'nyholm',       code: 'NYH', num: 2,  firstName: 'Kasper', lastName: 'Nyholm',        team: 'vantara',    country: 'DEN', pace: 0.98, consistency: 0.95, racecraft: 0.96 },
  { id: 'quintero',     code: 'QUI', num: 19, firstName: 'Rafael', lastName: 'Quintero',      team: 'vantara',    country: 'COL', pace: 0.96, consistency: 0.93, racecraft: 0.93 },
  { id: 'vesely',       code: 'VES', num: 8,  firstName: 'Dario',  lastName: 'Vesely',        team: 'solaris',    country: 'CZE', pace: 0.99, consistency: 0.96, racecraft: 0.98 },
  { id: 'raghunathan',  code: 'RAG', num: 34, firstName: 'Priya',  lastName: 'Raghunathan',   team: 'solaris',    country: 'IND', pace: 0.90, consistency: 0.87, racecraft: 0.88 },
  { id: 'vandenberg',   code: 'VDB', num: 15, firstName: 'Joris',  lastName: 'Vandenberg',    team: 'meridian',   country: 'BEL', pace: 0.95, consistency: 0.93, racecraft: 0.92 },
  { id: 'sorensen',     code: 'SOR', num: 47, firstName: 'Hana',   lastName: 'Sorensen',      team: 'meridian',   country: 'NOR', pace: 0.91, consistency: 0.86, racecraft: 0.88 },
  { id: 'ashcombe',     code: 'ASH', num: 22, firstName: 'Miles',  lastName: 'Ashcombe',      team: 'halcyon',    country: 'GBR', pace: 0.93, consistency: 0.92, racecraft: 0.96 },
  { id: 'aoyama',       code: 'AOY', num: 66, firstName: 'Kenji',  lastName: 'Aoyama',        team: 'halcyon',    country: 'JPN', pace: 0.84, consistency: 0.82, racecraft: 0.83 },
  { id: 'rautio',       code: 'RAU', num: 9,  firstName: 'Aleksi', lastName: 'Rautio',        team: 'norvik',     country: 'FIN', pace: 0.92, consistency: 0.91, racecraft: 0.91 },
  { id: 'dewolff',      code: 'DEW', num: 38, firstName: 'Bram',   lastName: 'de Wolff',      team: 'norvik',     country: 'NED', pace: 0.90, consistency: 0.89, racecraft: 0.89 },
  { id: 'brandenburg',  code: 'BDG', num: 25, firstName: 'Cole',   lastName: 'Brandenburg',   team: 'ironwood',   country: 'USA', pace: 0.87, consistency: 0.85, racecraft: 0.86 },
  { id: 'moretti',      code: 'MOR', num: 52, firstName: 'Silvia', lastName: 'Moretti',       team: 'ironwood',   country: 'ITA', pace: 0.85, consistency: 0.80, racecraft: 0.83 },
  { id: 'mizuno',       code: 'MIZ', num: 4,  firstName: 'Haruto', lastName: 'Mizuno',        team: 'kuroshio',   country: 'JPN', pace: 0.89, consistency: 0.88, racecraft: 0.88 },
  { id: 'park',         code: 'PRK', num: 71, firstName: 'Jiho',   lastName: 'Park',          team: 'kuroshio',   country: 'KOR', pace: 0.85, consistency: 0.81, racecraft: 0.84 },
  { id: 'aasgaard',     code: 'AAS', num: 17, firstName: 'Nils',   lastName: 'Aasgaard',      team: 'zephyr',     country: 'SWE', pace: 0.93, consistency: 0.90, racecraft: 0.87 },
  { id: 'boyd',         code: 'BOY', num: 60, firstName: 'Tamsin', lastName: 'Boyd',          team: 'zephyr',     country: 'AUS', pace: 0.87, consistency: 0.85, racecraft: 0.85 },
  { id: 'okonkwo',      code: 'OKO', num: 29, firstName: 'Idris',  lastName: 'Okonkwo',       team: 'sablewood',  country: 'NGA', pace: 0.88, consistency: 0.87, racecraft: 0.86 },
  { id: 'hoffmann',     code: 'HOF', num: 83, firstName: 'Lena',   lastName: 'Hoffmann',      team: 'sablewood',  country: 'GER', pace: 0.87, consistency: 0.84, racecraft: 0.85 },
  { id: 'almeida',      code: 'ALM', num: 13, firstName: 'Mateo',  lastName: 'Almeida',       team: 'stonehaven', country: 'BRA', pace: 0.86, consistency: 0.85, racecraft: 0.89 },
  { id: 'kovalenko',    code: 'KOV', num: 45, firstName: 'Sasha',  lastName: 'Kovalenko',     team: 'stonehaven', country: 'UKR', pace: 0.85, consistency: 0.88, racecraft: 0.84 },
];

export const CALENDAR = [
  // Circuit geometry in js/tracks.js is keyed by trackId. Every visible label
  // is invented: `gp` is a city event and `circuitName` is the venue name.
  { round: 1,  trackId: 'melbourne',   gp: 'Melbourne GP',   circuitName: 'Lakeside International Raceway', date: '2026-03-08', laps: 58 },
  { round: 2,  trackId: 'shanghai',    gp: 'Shanghai GP',    circuitName: 'Jade River Circuit',             date: '2026-03-15', laps: 56 },
  { round: 3,  trackId: 'suzuka',      gp: 'Suzuka GP',      circuitName: 'Crossover Park Raceway',         date: '2026-03-29', laps: 53 },
  { round: 4,  trackId: 'bahrain',     gp: 'Sakhir GP',      circuitName: 'Desert Star Circuit',            date: '2026-04-12', laps: 57 },
  { round: 5,  trackId: 'jeddah',      gp: 'Jeddah GP',      circuitName: 'Seawall Boulevard Circuit',      date: '2026-04-19', laps: 50 },
  { round: 6,  trackId: 'miami',       gp: 'Miami GP',       circuitName: 'Palm Basin Autodrome',           date: '2026-05-03', laps: 57 },
  { round: 7,  trackId: 'montreal',    gp: 'Montreal GP',    circuitName: 'Isle Park Circuit',              date: '2026-05-24', laps: 70 },
  { round: 8,  trackId: 'monaco',      gp: 'Monaco GP',      circuitName: 'Harbour Terrace Street Circuit', date: '2026-06-07', laps: 78 },
  { round: 9,  trackId: 'barcelona',   gp: 'Barcelona GP',   circuitName: 'Terra Alta Circuit',             date: '2026-06-14', laps: 66 },
  { round: 10, trackId: 'spielberg',   gp: 'Spielberg GP',   circuitName: 'Highland Crown Raceway',         date: '2026-06-28', laps: 71 },
  { round: 11, trackId: 'silverstone', gp: 'Silverstone GP', circuitName: 'Northgate Aerodrome Circuit',    date: '2026-07-05', laps: 52 },
  { round: 12, trackId: 'spa',         gp: 'Spa GP',         circuitName: 'Greenwood Forest Circuit',       date: '2026-07-19', laps: 44 },
  { round: 13, trackId: 'hungaroring', gp: 'Budapest GP',    circuitName: 'Danube Basin Raceway',           date: '2026-07-26', laps: 70 },
  { round: 14, trackId: 'zandvoort',   gp: 'Zandvoort GP',   circuitName: 'North Dune Circuit',             date: '2026-08-23', laps: 72 },
  { round: 15, trackId: 'monza',       gp: 'Monza GP',       circuitName: 'Royal Park Speedway',            date: '2026-09-06', laps: 53 },
  { round: 16, trackId: 'madrid',      gp: 'Madrid GP',      circuitName: 'Meseta Arena Circuit',           date: '2026-09-13', laps: 57 },
  { round: 17, trackId: 'baku',        gp: 'Baku GP',        circuitName: 'Caspian Gate Street Circuit',    date: '2026-09-27', laps: 51 },
  { round: 18, trackId: 'singapore',   gp: 'Singapore GP',   circuitName: 'Bayfront Night Circuit',         date: '2026-10-11', laps: 62 },
  { round: 19, trackId: 'austin',      gp: 'Austin GP',      circuitName: 'Lone Hill Circuit',              date: '2026-10-25', laps: 56 },
  { round: 20, trackId: 'mexico',      gp: 'Mexico City GP', circuitName: 'Altiplano Speedway',             date: '2026-11-01', laps: 71 },
  { round: 21, trackId: 'interlagos',  gp: 'Sao Paulo GP',   circuitName: 'Serra Sul Autodrome',            date: '2026-11-08', laps: 71 },
  { round: 22, trackId: 'lasvegas',    gp: 'Las Vegas GP',   circuitName: 'Neon Boulevard Circuit',         date: '2026-11-21', laps: 50 },
  { round: 23, trackId: 'lusail',      gp: 'Lusail GP',      circuitName: 'Dune Crescent Circuit',          date: '2026-11-29', laps: 57 },
  { round: 24, trackId: 'yasmarina',   gp: 'Abu Dhabi GP',   circuitName: 'Gulf Pearl Circuit',             date: '2026-12-06', laps: 58 },
];

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export const REGS_2026 = {
  minWeightKg: 768,
  powerICE_kW: 400,
  powerMGUK_kW: 350,
  fuel: '100% sustainable fuel',
  activeAero: { xMode: 'Low-drag straight-line mode', zMode: 'High-downforce cornering mode' },
  manualOverride: 'Electric overtaking boost (replaces DRS)',
  drs: false,
};
