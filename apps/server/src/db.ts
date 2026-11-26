import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type SQLite from 'better-sqlite3'
import type { BetterSQLite3Database, drizzle as BetterDrizzle } from 'drizzle-orm/better-sqlite3'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { BoardStatus, BridgeRuntime, DriverName, MessageBlock, PermissionMode, PresenceStatus } from '@chiorim/shared'

export const users = sqliteTable('users', {
  id: text().primaryKey(), kind: text({ enum: ['human', 'bot'] }).notNull(),
  username: text().notNull().unique(), display_name: text().notNull(), avatar_url: text(),
  bio: text().notNull().default(''), password_hash: text(),
  is_admin: integer({ mode: 'boolean' }).notNull().default(false),
  disabled: integer({ mode: 'boolean' }).notNull().default(false),
  presence_status: text({ enum: ['online', 'busy', 'away'] }).$type<PresenceStatus>().notNull().default('online'),
  status_text: text().notNull().default(''),
  created_at: integer().notNull(),
})
export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(), user_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  user_agent: text().notNull().default(''), ip_address: text().notNull().default(''),
  last_active_at: integer().notNull().default(0),
  expires_at: integer().notNull(), created_at: integer().notNull(),
}, t => [index('sessions_expiry').on(t.expires_at), index('sessions_user').on(t.user_id)])
export const invites = sqliteTable('invites', {
  code: text().primaryKey(), created_by: text().notNull().references(() => users.id),
  max_uses: integer().notNull().default(1), used_count: integer().notNull().default(0),
  expires_at: integer(), created_at: integer().notNull(),
})
export const providers = sqliteTable('providers', {
  id: text().primaryKey(), name: text().notNull(), type: text({ enum: ['openai_compat', 'anthropic', 'gemini'] }).notNull(),
  base_url: text().notNull(), api_key_enc: text().notNull(), models_json: text({ mode: 'json' }).$type<string[]>().notNull(),
  hermes_session_header: integer({ mode: 'boolean' }).notNull().default(false),
  created_by: text().notNull().references(() => users.id), created_at: integer().notNull(),
})
export const bots = sqliteTable('bots', {
  user_id: text().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  mode: text({ enum: ['provider', 'local', 'bridge'] }).notNull(),
  owner_id: text().notNull().references(() => users.id),
  trigger_policy: text({ enum: ['mention', 'always', 'dm_only'] }).notNull().default('mention'),
  provider_id: text().references(() => providers.id, { onDelete: 'set null' }),
  model: text(), system_prompt: text().notNull().default(''), temperature: real().notNull().default(0.7),
  context_limit: integer().notNull().default(20), token_hash: text().unique(),
  driver_hint: text().$type<DriverName>(), runtime_meta_json: text({ mode: 'json' }).$type<BridgeRuntime>(),
  local_cwd: text(),
  permission_mode: text({ enum: ['readonly', 'default', 'auto'] }).$type<PermissionMode>().notNull().default('default'),
  created_at: integer().notNull(),
})
export const workspaces = sqliteTable('workspaces', {
  id: text().primaryKey(),
  name: text().notNull(),
  icon: text(),
  color: text(),
  work_dir: text(),
  host_bot_id: text().references(() => users.id, { onDelete: 'set null' }),
  host_name: text(),
  description: text().notNull().default(''),
  created_by: text().notNull().references(() => users.id),
  created_at: integer().notNull(),
})
export const channels = sqliteTable('channels', {
  id: text().primaryKey(),
  workspace_id: text().references(() => workspaces.id, { onDelete: 'cascade' }),
  type: text({ enum: ['public', 'private', 'dm', 'board'] }).notNull(),
  name: text().notNull(), topic: text().notNull().default(''),
  system_context: text().notNull().default(''),
  work_dir: text(),
  dm_key: text().unique(),
  pinned_message_id: text().references((): AnySQLiteColumn => messages.id, { onDelete: 'set null' }),
  created_by: text().notNull().references(() => users.id), created_at: integer().notNull(),
}, t => [index('channels_workspace').on(t.workspace_id)])
export const channelMembers = sqliteTable('channel_members', {
  channel_id: text().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  user_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  last_read_message_id: text(), last_read_at: integer().notNull().default(0),
  muted: integer({ mode: 'boolean' }).notNull().default(false),
  joined_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.channel_id, t.user_id] }), index('channel_members_user').on(t.user_id)])
export const messages = sqliteTable('messages', {
  id: text().primaryKey(), channel_id: text().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  thread_root_id: text().references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
  reply_to_id: text().references((): AnySQLiteColumn => messages.id, { onDelete: 'set null' }),
  author_id: text().notNull().references(() => users.id),
  content: text().notNull().default(''), blocks_json: text({ mode: 'json' }).$type<MessageBlock[]>().notNull().default([]),
  status: text({ enum: ['streaming', 'done', 'aborted', 'error'] }).notNull().default('done'),
  error_message: text(),
  board_status: text({ enum: ['open', 'done'] }).$type<BoardStatus>(),
  webhook_name: text(),
  bot_hop_count: integer().notNull().default(0),
  created_at: integer().notNull(), updated_at: integer().notNull(),
}, t => [
  index('messages_channel_thread_time').on(t.channel_id, t.thread_root_id, t.created_at, t.id),
  index('messages_thread_time').on(t.thread_root_id, t.created_at),
  index('messages_channel_cursor').on(t.channel_id, t.id),
  index('messages_author').on(t.author_id),
])
export const botSessions = sqliteTable('bot_sessions', {
  bot_id: text().notNull().references(() => bots.user_id, { onDelete: 'cascade' }),
  scope_key: text().notNull(), external_session_id: text().notNull(), updated_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.bot_id, t.scope_key] })])
export const channelPins = sqliteTable('channel_pins', {
  channel_id: text().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  message_id: text().notNull().references(() => messages.id, { onDelete: 'cascade' }),
  pinned_by: text().notNull().references(() => users.id),
  created_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.channel_id, t.message_id] }), index('channel_pins_channel').on(t.channel_id, t.created_at)])
export const reactions = sqliteTable('reactions', {
  message_id: text().notNull().references(() => messages.id, { onDelete: 'cascade' }),
  user_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text().notNull(),
  created_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.message_id, t.user_id, t.emoji] }), index('reactions_message').on(t.message_id)])
export const bookmarks = sqliteTable('bookmarks', {
  user_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  message_id: text().notNull().references(() => messages.id, { onDelete: 'cascade' }),
  note: text().notNull().default(''),
  created_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.user_id, t.message_id] }), index('bookmarks_user').on(t.user_id, t.created_at)])
export const webhooks = sqliteTable('webhooks', {
  id: text().primaryKey(),
  channel_id: text().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  avatar_url: text(),
  token_hash: text().notNull().unique(),
  created_by: text().notNull().references(() => users.id),
  created_at: integer().notNull(),
}, t => [index('webhooks_channel').on(t.channel_id)])
export const queuedRuns = sqliteTable('queued_runs', {
  message_id: text().primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  bot_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel_id: text().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  source_message_id: text().notNull().references(() => messages.id, { onDelete: 'cascade' }),
  sender_id: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  created_at: integer().notNull(),
}, t => [index('queued_runs_bot').on(t.bot_id, t.created_at)])

const migrations = [`
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','bot')),
  username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, avatar_url TEXT, bio TEXT NOT NULL DEFAULT '',
  password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE invites (
  code TEXT PRIMARY KEY NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('openai_compat','anthropic','gemini')), base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL, models_json TEXT NOT NULL, hermes_session_header INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE bots (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('provider','bridge')), owner_id TEXT NOT NULL REFERENCES users(id),
  trigger_policy TEXT NOT NULL DEFAULT 'mention' CHECK(trigger_policy IN ('mention','always','dm_only')),
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, model TEXT, system_prompt TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.7, context_limit INTEGER NOT NULL DEFAULT 20, token_hash TEXT UNIQUE,
  driver_hint TEXT, runtime_meta_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL CHECK(type IN ('public','private','dm','board')),
  name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', dm_key TEXT UNIQUE,
  pinned_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, last_read_message_id TEXT,
  last_read_at INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, PRIMARY KEY(channel_id,user_id)
);
CREATE INDEX channel_members_user ON channel_members(user_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL DEFAULT '', blocks_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('streaming','done','aborted','error')),
  error_message TEXT, bot_hop_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX messages_channel_thread_time ON messages(channel_id,thread_root_id,created_at,id);
CREATE INDEX messages_thread_time ON messages(thread_root_id,created_at);
CREATE INDEX messages_channel_cursor ON messages(channel_id,id);
CREATE INDEX messages_author ON messages(author_id);
CREATE TABLE bot_sessions (
  bot_id TEXT NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE, scope_key TEXT NOT NULL,
  external_session_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,scope_key)
);
`, `
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'online' CHECK(presence_status IN ('online','busy','away'));
ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ip_address TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_user ON sessions(user_id);
ALTER TABLE channels ADD COLUMN system_context TEXT NOT NULL DEFAULT '';
ALTER TABLE channel_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN board_status TEXT CHECK(board_status IN ('open','done'));
ALTER TABLE messages ADD COLUMN webhook_name TEXT;
CREATE TABLE channel_pins (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id, message_id)
);
CREATE INDEX channel_pins_channel ON channel_pins(channel_id, created_at);
INSERT OR IGNORE INTO channel_pins (channel_id, message_id, pinned_by, created_at)
  SELECT id, pinned_message_id, created_by, created_at FROM channels WHERE pinned_message_id IS NOT NULL;
CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji)
);
CREATE INDEX reactions_message ON reactions(message_id);
CREATE TABLE bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, message_id)
);
CREATE INDEX bookmarks_user ON bookmarks(user_id, created_at);
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  token_hash TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX webhooks_channel ON webhooks(channel_id);
`, `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  work_dir TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
ALTER TABLE channels ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN work_dir TEXT;
CREATE INDEX channels_workspace ON channels(workspace_id);
`, `
ALTER TABLE workspaces ADD COLUMN host_bot_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN host_name TEXT;
CREATE TABLE queued_runs (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX queued_runs_bot ON queued_runs(bot_id, created_at);
`, `
CREATE TABLE bots_v5 (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('provider','local','bridge')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  trigger_policy TEXT NOT NULL DEFAULT 'mention' CHECK(trigger_policy IN ('mention','always','dm_only')),
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.7,
  context_limit INTEGER NOT NULL DEFAULT 20,
  token_hash TEXT UNIQUE,
  driver_hint TEXT,
  runtime_meta_json TEXT,
  local_cwd TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default' CHECK(permission_mode IN ('readonly','default','auto')),
  created_at INTEGER NOT NULL
);
INSERT INTO bots_v5 (user_id, mode, owner_id, trigger_policy, provider_id, model, system_prompt, temperature, context_limit, token_hash, driver_hint, runtime_meta_json, created_at)
  SELECT user_id, mode, owner_id, trigger_policy, provider_id, model, system_prompt, temperature, context_limit, token_hash, driver_hint, runtime_meta_json, created_at FROM bots;
DROP TABLE bots;
ALTER TABLE bots_v5 RENAME TO bots;
`]

export type Database = BetterSQLite3Database
export type OpenDatabase = { db: Database; sqlite: SQLite.Database }
type SqliteDriverFactory = (filename: string) => { sqlite: SQLite.Database; wrap: (sqlite: SQLite.Database) => Database }

const nodeRequire = createRequire(import.meta.url)
let sqliteFactory: SqliteDriverFactory = (filename: string) => {
  const BetterSqlite = nodeRequire('better-sqlite3') as typeof SQLite
  const { drizzle } = nodeRequire('drizzle-orm/better-sqlite3') as { drizzle: typeof BetterDrizzle }
  return { sqlite: new BetterSqlite(filename), wrap: (client) => drizzle(client) }
}

export function setSqliteDriver(factory: SqliteDriverFactory) {
  sqliteFactory = factory
}

export function maintainDatabase(sqlite: SQLite.Database, truncate = false) {
  try {
    sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
    sqlite.pragma(`wal_checkpoint(${truncate ? 'TRUNCATE' : 'PASSIVE'})`)
    sqlite.pragma('incremental_vacuum(64)')
    sqlite.pragma('optimize')
  } catch { /* Database may already be closed or read-only. */ }
}

export function openDatabase(filename: string): OpenDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const { sqlite, wrap } = sqliteFactory(filename)
  try {
    sqlite.pragma('busy_timeout = 5000')
    sqlite.pragma('foreign_keys = ON')
    if (filename !== ':memory:' && (sqlite.pragma('user_version', { simple: true }) as number) === 0) {
      sqlite.pragma('auto_vacuum = INCREMENTAL')
    }
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = NORMAL')
    // Keep SQLite page cache (~8 MiB) and WAL size (~8 MiB) bounded on small servers.
    sqlite.pragma('cache_size = -8000')
    sqlite.pragma('temp_store = MEMORY')
    sqlite.pragma('journal_size_limit = 8388608')
    const currentVersion = sqlite.pragma('user_version', { simple: true }) as number
    if (currentVersion > migrations.length) throw new Error('Database schema is newer than this server')
    const needsMigration = currentVersion < migrations.length
    if (needsMigration) sqlite.pragma('foreign_keys = OFF')
    try {
      sqlite.transaction(() => {
        const version = sqlite.pragma('user_version', { simple: true }) as number
        if (version > migrations.length) throw new Error('Database schema is newer than this server')
        migrations.slice(version).forEach(migration => sqlite.exec(migration))
        sqlite.pragma(`user_version = ${migrations.length}`)
        sqlite.prepare("UPDATE messages SET status='error', error_message='Server restarted during the run', updated_at=? WHERE status='streaming' AND id NOT IN (SELECT message_id FROM queued_runs)").run(Date.now())
        sqlite.prepare('UPDATE bots SET runtime_meta_json=NULL WHERE runtime_meta_json IS NOT NULL').run()
        const orphan = sqlite.prepare("SELECT id, created_by, created_at FROM channels WHERE type <> 'dm' AND workspace_id IS NULL LIMIT 1").get() as { id: string; created_by: string; created_at: number } | undefined
        if (orphan) {
          const existing = sqlite.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get() as { id: string } | undefined
          const wsId = existing?.id ?? 'default-workspace'
          if (!existing) {
            sqlite.prepare("INSERT INTO workspaces (id, name, icon, color, work_dir, description, created_by, created_at) VALUES (?, '客厅', 'CH', '#1e3a34', NULL, '', ?, ?)").run(wsId, orphan.created_by, orphan.created_at)
          }
          sqlite.prepare("UPDATE channels SET workspace_id = ? WHERE type <> 'dm' AND workspace_id IS NULL").run(wsId)
        }
      }).immediate()
    } finally {
      if (needsMigration) sqlite.pragma('foreign_keys = ON')
    }
    if (needsMigration) {
      const violations = sqlite.pragma('foreign_key_check') as unknown[]
      if (violations.length) throw new Error('Database foreign key check failed after migration')
    }
    return { sqlite, db: wrap(sqlite) }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export type UserRow = typeof users.$inferSelect
export type BotRow = typeof bots.$inferSelect
export type WorkspaceRow = typeof workspaces.$inferSelect
export type ChannelRow = typeof channels.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type WebhookRow = typeof webhooks.$inferSelect
