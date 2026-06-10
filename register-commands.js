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
  { name: 'stats', description: 'Show bot and server stats' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
rest.put(Routes.applicationCommands('742118218402889839'), { body: commands })
  .then(() => console.log('✅ Slash commands registered!'))
  .catch(console.error);
