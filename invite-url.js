require('dotenv').config();
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const clientId = String(process.env.CLIENT_ID || '').trim();
const guildId = String(process.env.GUILD_ID || '').trim();

if (!/^\d{17,20}$/.test(clientId)) {
  console.error('Set CLIENT_ID in .env before generating the invite URL.');
  process.exit(1);
}

const permissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions
]).bitfield.toString();

const url = new URL('https://discord.com/oauth2/authorize');
url.searchParams.set('client_id', clientId);
url.searchParams.set('scope', 'bot applications.commands');
url.searchParams.set('permissions', permissions);
if (/^\d{17,20}$/.test(guildId)) {
  url.searchParams.set('guild_id', guildId);
  url.searchParams.set('disable_guild_select', 'true');
}

console.log(url.toString());

