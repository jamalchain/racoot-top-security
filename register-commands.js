require('dotenv').config();
const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');

const commands = [
  {
    name: 'warn', description: 'Warn a user',
    options: [
      { name: 'user', description: 'User to warn', type: 6, required: true },
      { name: 'reason', description: 'Reason', type: 3 }
    ]
  },
  {
    name: 'kick', description: 'Kick a user',
    options: [
      { name: 'user', description: 'User to kick', type: 6, required: true },
      { name: 'reason', description: 'Reason', type: 3 }
    ]
  },
  {
    name: 'ban', description: 'Ban a user',
    options: [
      { name: 'user', description: 'User to ban', type: 6, required: true },
      { name: 'reason', description: 'Reason', type: 3 }
    ]
  },
  {
    name: 'mute', description: 'Timeout a user',
    options: [
      { name: 'user', description: 'User to mute', type: 6, required: true },
      { name: 'minutes', description: 'Duration in minutes', type: 4 }
    ]
  },
  { name: 'stats', description: 'Show bot and server stats' },
  {
    name: 'setlogs',
    description: 'Set the moderation log channel for this server',
    options: [
      { name: 'channel', description: 'Channel to send mod logs to', type: 7 /* CHANNEL */, required: true }
    ]
  },
  {
    name: 'setpunishment',
    description: 'Configure the punishment for an auto-protection system',
    options: [
      {
        name: 'system',
        description: 'Which system to configure',
        type: 3 /* STRING */,
        required: true,
        choices: [
          { name: 'Anti-Nuke',   value: 'antinuke'   },
          { name: 'Anti-Spam',   value: 'antispam'   },
          { name: 'Anti-Vanity', value: 'antivanity' },
        ]
      },
      {
        name: 'punishment',
        description: 'Punishment to apply',
        type: 3 /* STRING */,
        required: true,
        choices: [
          { name: 'Warn', value: 'warn' },
          { name: 'Kick', value: 'kick' },
          { name: 'Ban',  value: 'ban'  },
        ]
      }
    ]
  },
  {
    name: 'getconfig',
    description: 'Show the current security configuration for this server',
  },

  // ── Channel management ──────────────────────────────────────────────
  {
    name: 'slowmode',
    description: 'Set slowmode for the current channel',
    options: [
      { name: 'seconds', description: 'Slowmode delay in seconds (0 to disable)', type: 4, required: true },
    ],
  },
  {
    name: 'lock',
    description: 'Lock a channel so members cannot send messages',
    options: [
      { name: 'channel', description: 'Channel to lock (defaults to current)',   type: 7 },
      { name: 'reason',  description: 'Reason',                                  type: 3 },
    ],
  },
  {
    name: 'unlock',
    description: 'Unlock a previously locked channel',
    options: [
      { name: 'channel', description: 'Channel to unlock (defaults to current)', type: 7 },
      { name: 'reason',  description: 'Reason',                                  type: 3 },
    ],
  },
  {
    name: 'clear',
    description: 'Bulk-delete messages from the current channel',
    options: [
      { name: 'amount', description: 'Number of messages to delete (1-100)', type: 4, required: true },
    ],
  },
  {
    name: 'purge',
    description: 'Bulk-delete messages from a specific user in this channel',
    options: [
      { name: 'user',   description: 'User whose messages to delete',      type: 6, required: true },
      { name: 'amount', description: 'Number of messages to scan (1-100)', type: 4 },
    ],
  },

  // ── Member management ───────────────────────────────────────────────
  {
    name: 'nickname',
    description: "Change a member's nickname",
    options: [
      { name: 'user',     description: 'Target member',                    type: 6, required: true },
      { name: 'nickname', description: 'New nickname (omit to reset)',      type: 3 },
    ],
  },
  {
    name: 'role',
    description: 'Add or remove a role from a member',
    options: [
      {
        name: 'action', description: 'Add or remove', type: 3, required: true,
        choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }],
      },
      { name: 'user', description: 'Target member',        type: 6, required: true },
      { name: 'role', description: 'Role to add/remove',   type: 8, required: true },
    ],
  },
  {
    name: 'unban',
    description: 'Unban a user by their ID',
    options: [
      { name: 'userid', description: 'ID of the user to unban', type: 3, required: true },
      { name: 'reason', description: 'Reason',                  type: 3 },
    ],
  },
  {
    name: 'softban',
    description: 'Ban then immediately unban a user (clears recent messages)',
    options: [
      { name: 'user',   description: 'User to softban', type: 6, required: true },
      { name: 'reason', description: 'Reason',          type: 3 },
    ],
  },
  {
    name: 'tempban',
    description: 'Temporarily ban a user',
    options: [
      { name: 'user',    description: 'User to ban',             type: 6, required: true },
      { name: 'minutes', description: 'Ban duration in minutes', type: 4, required: true },
      { name: 'reason',  description: 'Reason',                  type: 3 },
    ],
  },
  {
    name: 'tempmute',
    description: 'Temporarily mute (timeout) a user',
    options: [
      { name: 'user',    description: 'User to mute',             type: 6, required: true },
      { name: 'minutes', description: 'Mute duration in minutes', type: 4, required: true },
      { name: 'reason',  description: 'Reason',                   type: 3 },
    ],
  },
  {
    name: 'unmute',
    description: 'Remove timeout from a user',
    options: [
      { name: 'user',   description: 'User to unmute', type: 6, required: true },
      { name: 'reason', description: 'Reason',         type: 3 },
    ],
  },

  // ── Warning management ──────────────────────────────────────────────
  {
    name: 'warn-list',
    description: 'Show all warnings for a user',
    options: [
      { name: 'user', description: 'User to check', type: 6, required: true },
    ],
  },
  {
    name: 'clear-warns',
    description: 'Clear all warnings for a user',
    options: [
      { name: 'user',   description: 'User to clear warnings for', type: 6, required: true },
      { name: 'reason', description: 'Reason',                     type: 3 },
    ],
  },

  // ── Mod log utilities ───────────────────────────────────────────────
  {
    name: 'modlog',
    description: 'Show recent moderation log entries for a user',
    options: [
      { name: 'user', description: 'User to look up', type: 6, required: true },
    ],
  },
  {
    name: 'reason',
    description: 'Update the reason for the most recent mod action on a user',
    options: [
      { name: 'user',   description: 'User the action was taken on', type: 6, required: true },
      { name: 'reason', description: 'New reason',                   type: 3, required: true },
    ],
  },

  // ── Appeals & protection toggles ───────────────────────────────────
  {
    name: 'appeal',
    description: 'Create a ban/mute appeal ticket',
    options: [
      { name: 'reason', description: 'Why you believe the action should be reversed', type: 3, required: true },
    ],
  },
  {
    name: 'antiraid',
    description: 'Toggle anti-raid protection on or off',
    options: [
      {
        name: 'enabled', description: 'Enable or disable', type: 3, required: true,
        choices: [{ name: 'Enable', value: 'true' }, { name: 'Disable', value: 'false' }],
      },
    ],
  },
  {
    name: 'antispam',
    description: 'Toggle anti-spam protection on or off',
    options: [
      {
        name: 'enabled', description: 'Enable or disable', type: 3, required: true,
        choices: [{ name: 'Enable', value: 'true' }, { name: 'Disable', value: 'false' }],
      },
    ],
  },

  // ── Server settings ─────────────────────────────────────────────────
  {
    name: 'autorole',
    description: 'Set a role to automatically assign to new members',
    options: [
      { name: 'role', description: 'Role to assign on join (omit to disable)', type: 8 },
    ],
  },
  {
    name: 'welcome',
    description: 'Set the welcome message channel and text',
    options: [
      { name: 'channel', description: 'Channel to send welcome messages in',                    type: 7, required: true },
      { name: 'message', description: 'Welcome text (use {user} and {server} as placeholders)', type: 3 },
    ],
  },
  {
    name: 'goodbye',
    description: 'Set the goodbye message channel and text',
    options: [
      { name: 'channel', description: 'Channel to send goodbye messages in',                    type: 7, required: true },
      { name: 'message', description: 'Goodbye text (use {user} and {server} as placeholders)', type: 3 },
    ],
  },
  {
    name: 'prefix',
    description: 'Set a custom command prefix for legacy text commands',
    options: [
      { name: 'prefix', description: 'New prefix (e.g. !, ?, $)', type: 3, required: true },
    ],
  },
  {
    name: 'language',
    description: 'Set the bot response language for this server',
    options: [
      {
        name: 'lang', description: 'Language', type: 3, required: true,
        choices: [
          { name: 'English',    value: 'en' },
          { name: 'Spanish',    value: 'es' },
          { name: 'French',     value: 'fr' },
          { name: 'German',     value: 'de' },
          { name: 'Portuguese', value: 'pt' },
        ],
      },
    ],
  },
  {
    name: 'timezone',
    description: 'Set the server timezone used for timestamps',
    options: [
      { name: 'timezone', description: 'Timezone (e.g. America/New_York, Europe/London)', type: 3, required: true },
    ],
  },
];

const CLIENT_ID = '742118218402889839';
const GUILD_ID = process.env.GUILD_ID;

if (!GUILD_ID) {
  console.error('❌ GUILD_ID environment variable is not set.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  .then(() => console.log(`✅ Slash commands registered to guild ${GUILD_ID}!`))
  .catch(console.error);
