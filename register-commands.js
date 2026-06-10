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
