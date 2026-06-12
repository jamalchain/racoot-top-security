require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder, Collection } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── Config persistence ──────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getServerConfig(guildId) {
  const cfg = loadConfig();
  if (!cfg[guildId]) {
    cfg[guildId] = {
      antiNukePunishment: 'ban',
      antiSpamPunishment: 'warn',
      antiVanityPunishment: 'kick',
      logChannelId: null,
    };
    saveConfig(cfg);
  }
  return cfg[guildId];
}

function setServerConfig(guildId, updates) {
  const cfg = loadConfig();
  cfg[guildId] = { ...getServerConfig(guildId), ...updates };
  saveConfig(cfg);
}

// ─── In-memory stores ───────────────────────────────────────────────
const spamMap    = new Map(); // `${guildId}:${userId}` -> { count, timer }
const nukeMap    = new Map(); // `${guildId}:${userId}` -> { count, timer }
const raidMap    = new Map(); // guildId -> { joins, timer }
const warnMap    = new Map(); // `${guildId}:${userId}` -> warnCount

const BANNED_WORDS  = ['badword1', 'badword2']; // customize as needed
const SPAM_LIMIT    = 5;   // messages per 5 s
const RAID_LIMIT    = 10;  // joins per 10 s
const NUKE_LIMIT    = 3;   // deletions per 10 s
const MAX_MENTIONS  = 5;

const INVITE_REGEX = /discord(?:\.gg|(?:app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;

// ─── Mod-log helper ──────────────────────────────────────────────────
async function sendModLog(guild, { action, user, moderator, reason }) {
  const { logChannelId } = getServerConfig(guild.id);
  if (!logChannelId) return;
  const logChannel = guild.channels.cache.get(logChannelId);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🛡 Mod Log — ${action}`)
    .addFields(
      { name: 'User',      value: `${user.tag} (${user.id})`,           inline: true },
      { name: 'Moderator', value: moderator ? `${moderator.tag}` : 'Racoot Security (auto)', inline: true },
      { name: 'Reason',    value: reason,                                inline: false },
    )
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(() => {});
}

// ─── Owner DM helper ────────────────────────────────────────────────
async function notifyOwner(guild, { triggeredBy, what }) {
  try {
    const owner = await guild.fetchOwner();
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle('🚨 Anti-Nuke Triggered')
      .addFields(
        { name: 'Server',      value: guild.name,                                    inline: true },
        { name: 'Triggered by', value: `${triggeredBy.user.tag} (${triggeredBy.id})`, inline: true },
        { name: 'Action',      value: what,                                           inline: false },
      )
      .setTimestamp();
    await owner.user.send({ embeds: [embed] }).catch(() => {});
  } catch {
    // Owner DMs may be closed — fail silently
  }
}

// ─── Apply punishment by type ────────────────────────────────────────
async function applyPunishment(member, guild, punishment, reason, moderator = null) {
  const tag = member.user.tag;
  switch (punishment) {
    case 'ban':
      await member.ban({ reason: `Racoot Security: ${reason}` }).catch(() => {});
      await sendModLog(guild, { action: 'Ban', user: member.user, moderator, reason });
      break;
    case 'kick':
      await member.kick(`Racoot Security: ${reason}`).catch(() => {});
      await sendModLog(guild, { action: 'Kick', user: member.user, moderator, reason });
      break;
    case 'warn':
    default: {
      const key = `${guild.id}:${member.id}`;
      const warns = (warnMap.get(key) || 0) + 1;
      warnMap.set(key, warns);
      await sendModLog(guild, { action: `Warn (${warns})`, user: member.user, moderator, reason });
      break;
    }
  }
}

// ─── Status helper ───────────────────────────────────────────────────
function updateStatus() {
  const count = client.guilds.cache.size;
  client.user.setActivity(`🛡 Protecting ${count} server${count !== 1 ? 's' : ''}`, { type: 3 });
}

// ─── Ready ──────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Racoot Security is online as ${client.user.tag}`);
  updateStatus();
  // Refresh status every 5 minutes in case cache drifts
  setInterval(updateStatus, 5 * 60 * 1000);
});

// Update status whenever the bot joins or leaves a server
client.on('guildCreate', () => updateStatus());
client.on('guildDelete', () => updateStatus());

// ─── Anti-Spam + Anti-Vanity + Auto-Mod ─────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const member = message.member;
  if (member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const userId  = message.author.id;
  const guildId = message.guild.id;
  const content = message.content.toLowerCase();
  const key     = `${guildId}:${userId}`;
  const cfg     = getServerConfig(guildId);

  // Banned words
  if (BANNED_WORDS.some(w => content.includes(w))) {
    await message.delete().catch(() => {});
    return message.channel
      .send(`⚠️ ${message.author}, that word is not allowed here.`)
      .then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
  }

  // Mass mentions
  if (message.mentions.users.size >= MAX_MENTIONS) {
    await message.delete().catch(() => {});
    await punish(member, message.channel, 'Mass mention');
    return;
  }

  // Anti-vanity: detect Discord invite links
  if (INVITE_REGEX.test(message.content)) {
    await message.delete().catch(() => {});
    await applyPunishment(member, message.guild, cfg.antiVanityPunishment, 'Posting Discord invite link (anti-vanity)');
    message.channel
      .send(`🔗 ${member.user.tag} — invite links are not allowed here.`)
      .then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
    return;
  }

  // Anti-spam
  const spamData = spamMap.get(key) || { count: 0, timer: null };
  spamData.count++;
  if (spamData.timer) clearTimeout(spamData.timer);
  spamData.timer = setTimeout(() => spamMap.delete(key), 5000);
  spamMap.set(key, spamData);

  if (spamData.count >= SPAM_LIMIT) {
    spamMap.delete(key);
    await message.channel.bulkDelete(
      (await message.channel.messages.fetch({ limit: 10 })).filter(m => m.author.id === userId)
    ).catch(() => {});
    await applyPunishment(member, message.guild, cfg.antiSpamPunishment, 'Spam (5+ messages in 5 seconds)');
    message.channel
      .send(`🚫 ${member.user.tag} triggered anti-spam protection.`)
      .then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
  }
});

// ─── Anti-Nuke: channel deletions ───────────────────────────────────
client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  const guild = channel.guild;

  // Fetch the audit log to find who deleted the channel
  const auditLogs = await guild.fetchAuditLogs({ type: 12 /* CHANNEL_DELETE */, limit: 1 }).catch(() => null);
  if (!auditLogs) return;
  const entry = auditLogs.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 5000) return;

  const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
  if (!executor || executor.id === client.user.id) return;
  if (executor.permissions.has(PermissionFlagsBits.Administrator)) return;

  const key = `${guild.id}:${executor.id}`;
  const data = nukeMap.get(key) || { count: 0, timer: null };
  data.count++;
  if (data.timer) clearTimeout(data.timer);
  data.timer = setTimeout(() => nukeMap.delete(key), 10000);
  nukeMap.set(key, data);

  if (data.count >= NUKE_LIMIT) {
    nukeMap.delete(key);
    const cfg = getServerConfig(guild.id);
    await applyPunishment(executor, guild, cfg.antiNukePunishment, `Anti-nuke: deleted ${data.count} channels in 10 seconds`);
    await notifyOwner(guild, { triggeredBy: executor, what: `Deleted ${data.count} channels in 10 seconds` });
  }
});

// ─── Anti-Nuke: role deletions ───────────────────────────────────────
client.on('roleDelete', async (role) => {
  const guild = role.guild;

  const auditLogs = await guild.fetchAuditLogs({ type: 32 /* ROLE_DELETE */, limit: 1 }).catch(() => null);
  if (!auditLogs) return;
  const entry = auditLogs.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 5000) return;

  const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
  if (!executor || executor.id === client.user.id) return;
  if (executor.permissions.has(PermissionFlagsBits.Administrator)) return;

  const key = `${guild.id}:${executor.id}`;
  const data = nukeMap.get(key) || { count: 0, timer: null };
  data.count++;
  if (data.timer) clearTimeout(data.timer);
  data.timer = setTimeout(() => nukeMap.delete(key), 10000);
  nukeMap.set(key, data);

  if (data.count >= NUKE_LIMIT) {
    nukeMap.delete(key);
    const cfg = getServerConfig(guild.id);
    await applyPunishment(executor, guild, cfg.antiNukePunishment, `Anti-nuke: deleted ${data.count} roles in 10 seconds`);
    await notifyOwner(guild, { triggeredBy: executor, what: `Deleted ${data.count} roles in 10 seconds` });
  }
});

// ─── Anti-Nuke: mass member kicks/bans ──────────────────────────────
client.on('guildMemberRemove', async (member) => {
  const guild = member.guild;

  // Check both KICK_MEMBER (20) and BAN_MEMBER (22) audit log types
  for (const auditType of [20, 22]) {
    const auditLogs = await guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null);
    if (!auditLogs) continue;
    const entry = auditLogs.entries.first();
    if (!entry || Date.now() - entry.createdTimestamp > 5000) continue;
    if (entry.target?.id !== member.id) continue;

    const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
    if (!executor || executor.id === client.user.id) continue;
    if (executor.permissions.has(PermissionFlagsBits.Administrator)) continue;

    const key = `${guild.id}:${executor.id}`;
    const data = nukeMap.get(key) || { count: 0, timer: null };
    data.count++;
    if (data.timer) clearTimeout(data.timer);
    data.timer = setTimeout(() => nukeMap.delete(key), 10000);
    nukeMap.set(key, data);

    if (data.count >= NUKE_LIMIT) {
      nukeMap.delete(key);
      const cfg = getServerConfig(guild.id);
      const actionName = auditType === 22 ? 'banned' : 'kicked';
      await applyPunishment(executor, guild, cfg.antiNukePunishment, `Anti-nuke: ${actionName} ${data.count} members in 10 seconds`);
      await notifyOwner(guild, { triggeredBy: executor, what: `${actionName} ${data.count} members in 10 seconds` });
    }
    break;
  }
});

// ─── Anti-Raid ──────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const guildId = member.guild.id;
  const data = raidMap.get(guildId) || { joins: 0, timer: null };
  data.joins++;
  if (data.timer) clearTimeout(data.timer);
  data.timer = setTimeout(() => raidMap.delete(guildId), 10000);
  raidMap.set(guildId, data);

  if (data.joins >= RAID_LIMIT) {
    raidMap.delete(guildId);
    await member.kick('Raid protection').catch(() => {});
    const { logChannelId } = getServerConfig(guildId);
    const logChannel = logChannelId
      ? member.guild.channels.cache.get(logChannelId)
      : member.guild.channels.cache.find(c => c.name === 'security-logs' || c.name === 'mod-log');
    if (logChannel) {
      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('🚨 RAID DETECTED')
        .setDescription(`Mass join detected! ${data.joins} members joined in 10 seconds.\n${member.user.tag} was kicked.`)
        .setTimestamp();
      logChannel.send({ embeds: [embed] }).catch(() => {});
    }
  }
});

// ─── Legacy punishment helper (used by mass-mention / auto-mod) ──────
async function punish(member, channel, reason) {
  const key   = `${member.guild.id}:${member.user.id}`;
  const warns = (warnMap.get(key) || 0) + 1;
  warnMap.set(key, warns);

  await sendModLog(member.guild, { action: `Auto-mod warn (${warns})`, user: member.user, moderator: null, reason });

  if (warns >= 3) {
    await member.ban({ reason: `Racoot Security: ${reason} (3 warnings)` }).catch(() => {});
    await sendModLog(member.guild, { action: 'Auto-mod ban', user: member.user, moderator: null, reason: `${reason} — reached 3 warnings` });
    channel.send(`🔨 ${member.user.tag} has been **banned** for repeated violations.`).then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
    warnMap.delete(key);
  } else if (warns >= 2) {
    await member.kick(`Racoot Security: ${reason}`).catch(() => {});
    await sendModLog(member.guild, { action: 'Auto-mod kick', user: member.user, moderator: null, reason: `${reason} — warning ${warns}/3` });
    channel.send(`👢 ${member.user.tag} has been **kicked** (Warning ${warns}/3).`).then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
  } else {
    await member.timeout(5 * 60 * 1000, `Racoot Security: ${reason}`).catch(() => {});
    channel.send(`⏱ ${member.user.tag} has been **timed out** for 5 minutes (Warning ${warns}/3).`).then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
  }
}

// ─── Slash Commands ─────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild() || !interaction.member) {
    return interaction.reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
  }
  const { commandName, options, member, guild } = interaction;

  // /getconfig and /setlogs /setpunishment require ManageGuild
  const isConfigCommand = ['setlogs', 'setpunishment', 'getconfig'].includes(commandName);
  const requiredPerm = isConfigCommand ? PermissionFlagsBits.ManageGuild : PermissionFlagsBits.ModerateMembers;

  if (!member.permissions.has(requiredPerm)) {
    return interaction.reply({ content: '❌ You lack permission to use this command.', ephemeral: true });
  }

  // ── /warn ──────────────────────────────────────────────────────────
  if (commandName === 'warn') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    const key    = `${guild.id}:${target.id}`;
    const warns  = (warnMap.get(key) || 0) + 1;
    warnMap.set(key, warns);
    await sendModLog(guild, { action: `Warn (${warns})`, user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `⚠️ ${target.user.tag} warned. (${warns} total) — ${reason}` });

  // ── /kick ──────────────────────────────────────────────────────────
  } else if (commandName === 'kick') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    await target.kick(reason);
    await sendModLog(guild, { action: 'Kick', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `👢 ${target.user.tag} has been kicked. Reason: ${reason}` });

  // ── /ban ───────────────────────────────────────────────────────────
  } else if (commandName === 'ban') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    await target.ban({ reason });
    await sendModLog(guild, { action: 'Ban', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `🔨 ${target.user.tag} has been banned. Reason: ${reason}` });

  // ── /mute ──────────────────────────────────────────────────────────
  } else if (commandName === 'mute') {
    const target  = options.getMember('user');
    const minutes = options.getInteger('minutes') || 10;
    await target.timeout(minutes * 60 * 1000, 'Muted by moderator');
    await sendModLog(guild, { action: `Mute (${minutes}m)`, user: target.user, moderator: member.user, reason: 'Muted by moderator' });
    interaction.reply({ content: `🔇 ${target.user.tag} muted for ${minutes} minutes.` });

  // ── /stats ─────────────────────────────────────────────────────────
  } else if (commandName === 'stats') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🛡 Racoot Security Stats')
      .addFields(
        { name: 'Guild',       value: guild.name,              inline: true },
        { name: 'Members',     value: `${guild.memberCount}`,  inline: true },
        { name: 'Bot Latency', value: `${client.ws.ping}ms`,   inline: true },
      )
      .setTimestamp();
    interaction.reply({ embeds: [embed] });

  // ── /setlogs ───────────────────────────────────────────────────────
  } else if (commandName === 'setlogs') {
    const channel = options.getChannel('channel');
    setServerConfig(guild.id, { logChannelId: channel.id });
    interaction.reply({ content: `✅ Mod log channel set to ${channel}.`, ephemeral: true });

  // ── /setpunishment ─────────────────────────────────────────────────
  } else if (commandName === 'setpunishment') {
    const system     = options.getString('system');
    const punishment = options.getString('punishment');
    const keyMap = {
      antinuke:   'antiNukePunishment',
      antispam:   'antiSpamPunishment',
      antivanity: 'antiVanityPunishment',
    };
    const cfgKey = keyMap[system];
    if (!cfgKey) return interaction.reply({ content: '❌ Unknown system.', ephemeral: true });
    setServerConfig(guild.id, { [cfgKey]: punishment });
    interaction.reply({ content: `✅ **${system}** punishment set to **${punishment}**.`, ephemeral: true });

  // ── /getconfig ─────────────────────────────────────────────────────
  } else if (commandName === 'getconfig') {
    const cfg = getServerConfig(guild.id);
    const logChannel = cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`⚙️ Server Config — ${guild.name}`)
      .addFields(
        { name: 'Log Channel',          value: logChannel,                  inline: false },
        { name: 'Anti-Nuke Punishment',   value: cfg.antiNukePunishment,    inline: true  },
        { name: 'Anti-Spam Punishment',   value: cfg.antiSpamPunishment,    inline: true  },
        { name: 'Anti-Vanity Punishment', value: cfg.antiVanityPunishment,  inline: true  },
      )
      .setTimestamp();
    interaction.reply({ embeds: [embed], ephemeral: true });

  // ── /slowmode ──────────────────────────────────────────────────────
  } else if (commandName === 'slowmode') {
    const seconds = options.getInteger('seconds');
    if (seconds < 0 || seconds > 21600)
      return interaction.reply({ content: '❌ Slowmode must be between 0 and 21600 seconds.', ephemeral: true });
    await interaction.channel.setRateLimitPerUser(seconds, `Set by ${member.user.tag}`);
    await sendModLog(guild, { action: 'Slowmode', user: member.user, moderator: member.user, reason: `Set to ${seconds}s` });
    interaction.reply({ content: seconds === 0 ? '✅ Slowmode disabled.' : `✅ Slowmode set to **${seconds}s**.` });

  // ── /lock ──────────────────────────────────────────────────────────
  } else if (commandName === 'lock') {
    const target  = options.getChannel('channel') || interaction.channel;
    const reason  = options.getString('reason') || 'No reason';
    await target.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Lock by ${member.user.tag}: ${reason}` });
    await sendModLog(guild, { action: 'Lock', user: member.user, moderator: member.user, reason: `${target.name} — ${reason}` });
    interaction.reply({ content: `🔒 ${target} has been locked. Reason: ${reason}` });

  // ── /unlock ────────────────────────────────────────────────────────
  } else if (commandName === 'unlock') {
    const target  = options.getChannel('channel') || interaction.channel;
    const reason  = options.getString('reason') || 'No reason';
    await target.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: `Unlock by ${member.user.tag}: ${reason}` });
    await sendModLog(guild, { action: 'Unlock', user: member.user, moderator: member.user, reason: `${target.name} — ${reason}` });
    interaction.reply({ content: `🔓 ${target} has been unlocked. Reason: ${reason}` });

  // ── /clear ─────────────────────────────────────────────────────────
  } else if (commandName === 'clear') {
    const amount = options.getInteger('amount');
    if (amount < 1 || amount > 100)
      return interaction.reply({ content: '❌ Amount must be between 1 and 100.', ephemeral: true });
    const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
    if (!deleted) return interaction.reply({ content: '❌ Could not delete messages (they may be older than 14 days).', ephemeral: true });
    await sendModLog(guild, { action: 'Clear', user: member.user, moderator: member.user, reason: `Deleted ${deleted.size} messages in #${interaction.channel.name}` });
    interaction.reply({ content: `🗑️ Deleted **${deleted.size}** message(s).`, ephemeral: true });

  // ── /purge ─────────────────────────────────────────────────────────
  } else if (commandName === 'purge') {
    const target = options.getMember('user');
    const amount = options.getInteger('amount') || 50;
    const fetched = await interaction.channel.messages.fetch({ limit: Math.min(amount, 100) });
    const toDelete = fetched.filter(m => m.author.id === target.id).first(100);
    const deleted  = await interaction.channel.bulkDelete(toDelete, true).catch(() => null);
    if (!deleted) return interaction.reply({ content: '❌ Could not delete messages.', ephemeral: true });
    await sendModLog(guild, { action: 'Purge', user: target.user, moderator: member.user, reason: `Deleted ${deleted.size} messages from ${target.user.tag}` });
    interaction.reply({ content: `🗑️ Deleted **${deleted.size}** message(s) from ${target.user.tag}.`, ephemeral: true });

  // ── /nickname ──────────────────────────────────────────────────────
  } else if (commandName === 'nickname') {
    const target   = options.getMember('user');
    const nickname = options.getString('nickname') || null;
    await target.setNickname(nickname, `Changed by ${member.user.tag}`);
    await sendModLog(guild, { action: 'Nickname', user: target.user, moderator: member.user, reason: nickname ? `Set to: ${nickname}` : 'Reset to default' });
    interaction.reply({ content: nickname ? `✏️ Nickname for ${target.user.tag} set to **${nickname}**.` : `✏️ Nickname for ${target.user.tag} has been reset.` });

  // ── /role ──────────────────────────────────────────────────────────
  } else if (commandName === 'role') {
    const action = options.getString('action');
    const target = options.getMember('user');
    const role   = options.getRole('role');
    if (action === 'add') {
      await target.roles.add(role, `Added by ${member.user.tag}`);
      await sendModLog(guild, { action: 'Role Add', user: target.user, moderator: member.user, reason: `Added role: ${role.name}` });
      interaction.reply({ content: `✅ Added **${role.name}** to ${target.user.tag}.` });
    } else {
      await target.roles.remove(role, `Removed by ${member.user.tag}`);
      await sendModLog(guild, { action: 'Role Remove', user: target.user, moderator: member.user, reason: `Removed role: ${role.name}` });
      interaction.reply({ content: `✅ Removed **${role.name}** from ${target.user.tag}.` });
    }

  // ── /unban ─────────────────────────────────────────────────────────
  } else if (commandName === 'unban') {
    const userId = options.getString('userid');
    const reason = options.getString('reason') || 'No reason';
    await guild.members.unban(userId, reason).catch(() => {
      return interaction.reply({ content: `❌ Could not unban \`${userId}\`. Make sure the ID is correct.`, ephemeral: true });
    });
    if (!interaction.replied) {
      const unbanned = await client.users.fetch(userId).catch(() => ({ tag: userId }));
      await sendModLog(guild, { action: 'Unban', user: unbanned, moderator: member.user, reason });
      interaction.reply({ content: `✅ Unbanned \`${userId}\`. Reason: ${reason}` });
    }

  // ── /softban ───────────────────────────────────────────────────────
  } else if (commandName === 'softban') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    await target.ban({ deleteMessageSeconds: 7 * 24 * 60 * 60, reason: `Softban by ${member.user.tag}: ${reason}` });
    await guild.members.unban(target.id, 'Softban — immediate unban');
    await sendModLog(guild, { action: 'Softban', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `🔨 ${target.user.tag} has been softbanned (messages cleared). Reason: ${reason}` });

  // ── /tempban ───────────────────────────────────────────────────────
  } else if (commandName === 'tempban') {
    const target  = options.getMember('user');
    const minutes = options.getInteger('minutes');
    const reason  = options.getString('reason') || 'No reason';
    await target.ban({ reason: `Tempban (${minutes}m) by ${member.user.tag}: ${reason}` });
    await sendModLog(guild, { action: `Tempban (${minutes}m)`, user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `🔨 ${target.user.tag} has been banned for **${minutes} minute(s)**. Reason: ${reason}` });
    setTimeout(async () => {
      await guild.members.unban(target.id, 'Tempban expired').catch(() => {});
    }, minutes * 60 * 1000);

  // ── /tempmute ──────────────────────────────────────────────────────
  } else if (commandName === 'tempmute') {
    const target  = options.getMember('user');
    const minutes = options.getInteger('minutes');
    const reason  = options.getString('reason') || 'No reason';
    await target.timeout(minutes * 60 * 1000, `Tempmute by ${member.user.tag}: ${reason}`);
    await sendModLog(guild, { action: `Tempmute (${minutes}m)`, user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `🔇 ${target.user.tag} has been muted for **${minutes} minute(s)**. Reason: ${reason}` });

  // ── /unmute ────────────────────────────────────────────────────────
  } else if (commandName === 'unmute') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    await target.timeout(null, `Unmuted by ${member.user.tag}: ${reason}`);
    await sendModLog(guild, { action: 'Unmute', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `🔊 ${target.user.tag} has been unmuted. Reason: ${reason}` });

  // ── /warn-list ─────────────────────────────────────────────────────
  } else if (commandName === 'warn-list') {
    const target = options.getMember('user');
    const key    = `${guild.id}:${target.id}`;
    const warns  = warnMap.get(key) || 0;
    const embed  = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle(`⚠️ Warnings — ${target.user.tag}`)
      .setDescription(`This user has **${warns}** active warning(s).`)
      .setTimestamp();
    interaction.reply({ embeds: [embed], ephemeral: true });

  // ── /clear-warns ───────────────────────────────────────────────────
  } else if (commandName === 'clear-warns') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason';
    const key    = `${guild.id}:${target.id}`;
    warnMap.delete(key);
    await sendModLog(guild, { action: 'Clear Warns', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `✅ Warnings cleared for ${target.user.tag}. Reason: ${reason}` });

  // ── /modlog ────────────────────────────────────────────────────────
  } else if (commandName === 'modlog') {
    const target = options.getMember('user');
    const key    = `${guild.id}:${target.id}`;
    const warns  = warnMap.get(key) || 0;
    const embed  = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 Mod Log — ${target.user.tag}`)
      .addFields(
        { name: 'Active Warnings', value: `${warns}`, inline: true },
        { name: 'Note', value: 'Full persistent log requires a database integration.', inline: false },
      )
      .setTimestamp();
    interaction.reply({ embeds: [embed], ephemeral: true });

  // ── /reason ────────────────────────────────────────────────────────
  } else if (commandName === 'reason') {
    const target = options.getMember('user');
    const reason = options.getString('reason');
    await sendModLog(guild, { action: 'Reason Update', user: target.user, moderator: member.user, reason });
    interaction.reply({ content: `✅ Reason updated for ${target.user.tag}: ${reason}` });

  // ── /appeal ────────────────────────────────────────────────────────
  } else if (commandName === 'appeal') {
    const reason = options.getString('reason');
    const cfg    = getServerConfig(guild.id);
    const logChannel = cfg.logChannelId ? guild.channels.cache.get(cfg.logChannelId) : null;
    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle('📩 Ban/Mute Appeal')
      .addFields(
        { name: 'User',   value: `${member.user.tag} (${member.id})`, inline: true },
        { name: 'Reason', value: reason,                               inline: false },
      )
      .setTimestamp();
    if (logChannel) {
      await logChannel.send({ embeds: [embed] }).catch(() => {});
      interaction.reply({ content: '✅ Your appeal has been submitted to the moderation team.', ephemeral: true });
    } else {
      interaction.reply({ content: '❌ No log channel is configured. Ask an admin to run `/setlogs` first.', ephemeral: true });
    }

  // ── /antiraid ──────────────────────────────────────────────────────
  } else if (commandName === 'antiraid') {
    const enabled = options.getString('enabled') === 'true';
    setServerConfig(guild.id, { antiRaidEnabled: enabled });
    interaction.reply({ content: `✅ Anti-raid protection is now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });

  // ── /antispam ──────────────────────────────────────────────────────
  } else if (commandName === 'antispam') {
    const enabled = options.getString('enabled') === 'true';
    setServerConfig(guild.id, { antiSpamEnabled: enabled });
    interaction.reply({ content: `✅ Anti-spam protection is now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });

  // ── /autorole ──────────────────────────────────────────────────────
  } else if (commandName === 'autorole') {
    const role = options.getRole('role');
    setServerConfig(guild.id, { autoRoleId: role ? role.id : null });
    interaction.reply({ content: role ? `✅ Auto-role set to **${role.name}**.` : '✅ Auto-role disabled.', ephemeral: true });

  // ── /welcome ───────────────────────────────────────────────────────
  } else if (commandName === 'welcome') {
    const channel = options.getChannel('channel');
    const message = options.getString('message') || 'Welcome to **{server}**, {user}! 🎉';
    setServerConfig(guild.id, { welcomeChannelId: channel.id, welcomeMessage: message });
    interaction.reply({ content: `✅ Welcome messages will be sent to ${channel}.\nMessage: \`${message}\``, ephemeral: true });

  // ── /goodbye ───────────────────────────────────────────────────────
  } else if (commandName === 'goodbye') {
    const channel = options.getChannel('channel');
    const message = options.getString('message') || '**{user}** has left **{server}**. Goodbye! 👋';
    setServerConfig(guild.id, { goodbyeChannelId: channel.id, goodbyeMessage: message });
    interaction.reply({ content: `✅ Goodbye messages will be sent to ${channel}.\nMessage: \`${message}\``, ephemeral: true });

  // ── /prefix ────────────────────────────────────────────────────────
  } else if (commandName === 'prefix') {
    const prefix = options.getString('prefix');
    if (prefix.length > 5)
      return interaction.reply({ content: '❌ Prefix must be 5 characters or fewer.', ephemeral: true });
    setServerConfig(guild.id, { prefix });
    interaction.reply({ content: `✅ Custom prefix set to \`${prefix}\`.`, ephemeral: true });

  // ── /language ──────────────────────────────────────────────────────
  } else if (commandName === 'language') {
    const lang = options.getString('lang');
    setServerConfig(guild.id, { language: lang });
    interaction.reply({ content: `✅ Bot language set to **${lang}**.`, ephemeral: true });

  // ── /timezone ──────────────────────────────────────────────────────
  } else if (commandName === 'timezone') {
    const timezone = options.getString('timezone');
    // Basic validation — Intl will throw if the timezone is invalid
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return interaction.reply({ content: `❌ \`${timezone}\` is not a valid timezone. Use a format like \`America/New_York\` or \`Europe/London\`.`, ephemeral: true });
    }
    setServerConfig(guild.id, { timezone });
    interaction.reply({ content: `✅ Server timezone set to **${timezone}**.`, ephemeral: true });
  }
});

// ─── Welcome / Goodbye / Auto-role on member join ────────────────────
client.on('guildMemberAdd', async (member) => {
  const cfg = getServerConfig(member.guild.id);

  // Auto-role
  if (cfg.autoRoleId) {
    const role = member.guild.roles.cache.get(cfg.autoRoleId);
    if (role) await member.roles.add(role, 'Auto-role on join').catch(() => {});
  }

  // Welcome message
  if (cfg.welcomeChannelId) {
    const channel = member.guild.channels.cache.get(cfg.welcomeChannelId);
    if (channel) {
      const text = (cfg.welcomeMessage || 'Welcome to **{server}**, {user}! 🎉')
        .replace('{user}',   member.user.tag)
        .replace('{server}', member.guild.name);
      channel.send(text).catch(() => {});
    }
  }
});

// ─── Goodbye message on member leave ────────────────────────────────
client.on('guildMemberRemove', async (member) => {
  const cfg = getServerConfig(member.guild.id);
  if (cfg.goodbyeChannelId) {
    const channel = member.guild.channels.cache.get(cfg.goodbyeChannelId);
    if (channel) {
      const text = (cfg.goodbyeMessage || '**{user}** has left **{server}**. Goodbye! 👋')
        .replace('{user}',   member.user.tag)
        .replace('{server}', member.guild.name);
      channel.send(text).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
