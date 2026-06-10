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

// ─── Ready ──────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Racoot Security is online as ${client.user.tag}`);
  client.user.setActivity('🛡 Protecting servers', { type: 3 });
});

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
  }
});

client.login(process.env.DISCORD_TOKEN);
