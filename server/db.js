// Score storage: Node's built-in SQLite (no native modules to build on the server).
// Every finished race is kept forever. Times are stored as UTC ISO strings; clients
// show them in their own local time.

import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const today = () => new Date().toISOString().slice(0, 10); // UTC

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'scores.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS games (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      level       TEXT    NOT NULL,
      room        TEXT    NOT NULL,
      players     TEXT    NOT NULL,  -- JSON array of the crew's names, seat order
      time_ms     INTEGER NOT NULL,
      points      INTEGER NOT NULL,
      deaths      INTEGER NOT NULL,  -- kept for fun, not used for points
      started_at  TEXT    NOT NULL,
      finished_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_finished ON games (finished_at DESC);
  `);
  // v2: crews of 1-4 players, each with their own leaderboard. Older games were all 4-player.
  const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
  if (!cols.includes('crew_size')) db.exec('ALTER TABLE games ADD COLUMN crew_size INTEGER NOT NULL DEFAULT 4');
  db.exec('DROP INDEX IF EXISTS games_level_points');
  db.exec('CREATE INDEX IF NOT EXISTS games_board ON games (level, crew_size, points DESC)');

  // Rough site analytics. Raw IPs are never stored: a visitor is only a salted hash, per day.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS visitors_hash ON visitors (hash);
  `);
  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('visitor_salt', ?)`).run(randomBytes(16).toString('hex'));
  const salt = db.prepare(`SELECT value FROM meta WHERE key = 'visitor_salt'`).get().value;
  const addView = db.prepare(`INSERT INTO daily (day, views) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET views = views + 1`);
  const addVisitor = db.prepare(`INSERT OR IGNORE INTO visitors (day, hash) VALUES (?, ?)`);
  const setPeak = db.prepare(`INSERT INTO daily (day, peak) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET peak = MAX(peak, excluded.peak)`);
  const viewTotals = db.prepare(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(MAX(peak), 0) AS peak FROM daily`);
  const allVisitors = db.prepare(`SELECT COUNT(DISTINCT hash) AS n FROM visitors`);
  const lastDays = db.prepare(`
    SELECT d.day, d.views, d.peak,
      (SELECT COUNT(*) FROM visitors v WHERE v.day = d.day) AS visitors,
      (SELECT COUNT(*) FROM games g WHERE substr(g.finished_at, 1, 10) = d.day) AS races
    FROM daily d ORDER BY d.day DESC LIMIT ?`);
  const namedPlayers = db.prepare(`SELECT COUNT(DISTINCT lower(p.value)) AS n FROM games g, json_each(g.players) p`);

  const insert = db.prepare(`
    INSERT INTO games (level, room, players, crew_size, time_ms, points, deaths, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const top = db.prepare(`
    SELECT id, level, room, players, crew_size, time_ms, points, deaths, finished_at
    FROM games WHERE level = ? AND crew_size = ? ORDER BY points DESC, finished_at ASC LIMIT ?`);
  const recent = db.prepare(`
    SELECT id, level, room, players, crew_size, time_ms, points, deaths, finished_at
    FROM games ORDER BY finished_at DESC LIMIT ?`);
  const rankOf = db.prepare(`SELECT COUNT(*) AS better FROM games WHERE level = ? AND crew_size = ? AND points > ?`);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM games WHERE level = ? AND crew_size = ?`);

  // progress and history: a player's name appears in the players JSON of every race they finished
  const cleared = db.prepare(`
    SELECT g.level, MIN(g.time_ms) AS best_ms, MAX(g.points) AS best_points, COUNT(*) AS races
    FROM games g, json_each(g.players) p WHERE lower(p.value) = lower(?) GROUP BY g.level`);
  const totals = db.prepare(`SELECT COUNT(*) AS n FROM games`);
  const byLevel = db.prepare(`SELECT level, COUNT(*) AS n FROM games GROUP BY level`);
  const byCrew = db.prepare(`SELECT crew_size, COUNT(*) AS n FROM games GROUP BY crew_size`);
  const mineCount = db.prepare(`SELECT COUNT(*) AS n FROM games g, json_each(g.players) p WHERE lower(p.value) = lower(?)`);
  const mineRecent = db.prepare(`
    SELECT g.id, g.level, g.room, g.players, g.crew_size, g.time_ms, g.points, g.deaths, g.finished_at
    FROM games g, json_each(g.players) p WHERE lower(p.value) = lower(?) ORDER BY g.finished_at DESC LIMIT ?`);

  const row = (r) => ({ ...r, players: JSON.parse(r.players) });

  return {
    saveGame(g) {
      const info = insert.run(g.level, g.room, JSON.stringify(g.players), g.crewSize, g.timeMs, g.points, g.deaths, g.startedAt, g.finishedAt);
      const rank = rankOf.get(g.level, g.crewSize, g.points).better + 1;
      return { id: Number(info.lastInsertRowid), rank, of: count.get(g.level, g.crewSize).n };
    },
    // one board per crew size: solo runs and 4-player runs aren't comparable
    leaderboard(level, crewSize = 4, limit = 20) {
      return top.all(level, crewSize, limit).map(row);
    },
    recentGames(limit = 20) {
      return recent.all(limit).map(row);
    },
    // { levelId: { best_ms, best_points, races } } for every level this name has finished
    progress(name) {
      const out = {};
      if (name) for (const r of cleared.all(name)) out[r.level] = { best_ms: r.best_ms, best_points: r.best_points, races: r.races };
      return out;
    },
    history(name, limit = 50) {
      const count = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
      return {
        total: totals.get().n,
        byLevel: count(byLevel.all(), 'level'),
        byCrew: count(byCrew.all(), 'crew_size'),
        mine: name ? mineCount.get(name).n : null,
        games: (name ? mineRecent.all(name, limit) : recent.all(limit)).map(row),
      };
    },
    recordVisit(ip, userAgent, day = today()) {
      addView.run(day);
      addVisitor.run(day, createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 32));
    },
    recordPeak: (online, day = today()) => setPeak.run(day, online),
    analytics(days = 14) {
      const t = viewTotals.get();
      return {
        totalViews: t.views,
        totalVisitors: allVisitors.get().n,
        peakEver: t.peak,
        totalRaces: totals.get().n,
        totalPlayers: namedPlayers.get().n,
        days: lastDays.all(days).map((r) => ({ ...r })),
      };
    },
    close: () => db.close(),
  };
}
