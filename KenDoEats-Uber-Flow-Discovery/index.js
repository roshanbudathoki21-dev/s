const http = require('http');
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  AttachmentBuilder
} = require('discord.js');
const { chromium } = require('playwright');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const TRANSCRIPT_CHANNEL_ID = process.env.TRANSCRIPT_CHANNEL_ID || '1541157189899522058';
const PRICE_CHANNEL_ID = process.env.PRICE_CHANNEL_ID || '1538187163957596190';
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || '1537616840413413556';
const VOUCH_ROLE_ID = process.env.VOUCH_ROLE_ID || '1538299265305157692';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';


const pendingTickets = new Map();
const { TOKEN, CLIENT_ID, ADMIN_ROLE_ID, TICKET_CATEGORY_ID } = process.env;

const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Send the restaurant order ticket panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('resend')
    .setDescription('Resend the order information in the current ticket')
].map(c => c.toJSON());
const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));


async function fetchAllMessages(channel) {
  const all = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildTranscriptHtml(channel, messages) {
  const rows = messages.map(msg => {
    const author = escapeHtml(msg.author?.tag || msg.author?.username || 'Unknown');
    const time = new Date(msg.createdTimestamp).toLocaleString();
    const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
    const attachments = [...msg.attachments.values()]
      .map(a => `<div><a href="${escapeHtml(a.url)}">${escapeHtml(a.name || 'attachment')}</a></div>`)
      .join('');
    const embeds = msg.embeds?.length ? `<div class="embed-note">[${msg.embeds.length} embed(s)]</div>` : '';
    return `<div class="msg"><div class="meta"><strong>${author}</strong> <span>${escapeHtml(time)}</span></div><div class="content">${content || '<em>[no text]</em>'}${attachments}${embeds}</div></div>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Transcript - ${escapeHtml(channel.name)}</title>
<style>
body{font-family:Arial,sans-serif;background:#111827;color:#f3f4f6;margin:0;padding:24px}
.wrap{max-width:900px;margin:auto}
h1{font-size:22px}
.msg{padding:14px 0;border-bottom:1px solid #374151}
.meta{margin-bottom:6px}
.meta span{color:#9ca3af;font-size:12px;margin-left:8px}
.content{white-space:normal;line-height:1.45}
a{color:#60a5fa}
.embed-note{color:#9ca3af;font-size:12px;margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
<h1>Ticket Transcript: #${escapeHtml(channel.name)}</h1>
<p>Channel ID: ${escapeHtml(channel.id)}</p>
${rows}
</div>
</body>
</html>`;
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticketpanel') {
      const embed = new EmbedBuilder().setTitle('🍔 Open an Order Ticket').setDescription('Click **Open Ticket** and fill out:\n\n🍽️ What Restaurant?\n💰 Total Price After Fees\n💳 Payment Method — No CA\n\nOnly you and staff can see your ticket.');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Open Ticket').setStyle(ButtonStyle.Primary));
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: '✅ Ticket panel created.', ephemeral: true });
    }


    if (interaction.isChatInputCommand() && interaction.commandName === 'resend') {
      const topic = interaction.channel?.topic || '';

      if (!topic.startsWith('ticket-user:')) {
        return interaction.reply({
          content: 'This command can only be used inside an order ticket.',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const messages = await fetchAllMessages(interaction.channel);

        const originalOrderMessage = messages.find(message =>
          message.author?.id === client.user.id &&
          message.embeds?.some(embed =>
            String(embed.title || '').trim().toLowerCase() === 'kendoeats order ticket'
          )
        );

        if (!originalOrderMessage) {
          return interaction.editReply({
            content: 'I could not find the original order information in this ticket.'
          });
        }

        await interaction.channel.send({
          embeds: originalOrderMessage.embeds.map(embed => embed.toJSON()),
          components: originalOrderMessage.components.map(row => row.toJSON()),
          allowedMentions: { parse: [] }
        });

        return interaction.editReply({
          content: 'Order information resent.'
        });
      } catch (error) {
        console.error('RESEND ERROR:', error);

        return interaction.editReply({
          content: `Could not resend the order information. Error: ${String(error.message || error).slice(0, 350)}`
        });
      }
    }

    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      const existing = interaction.guild.channels.cache.find(
        c => c.topic === `ticket-user:${interaction.user.id}`
      );

      if (existing) {
        return interaction.reply({
          content: `❌ You already have an open ticket: ${existing}`,
          ephemeral: true
        });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId('fulfillment_type')
        .setPlaceholder('Pick Up or Delivery?')
        .addOptions(
          {
            label: 'Pick Up',
            value: 'pickup',
            description: 'I will pick up the order'
          },
          {
            label: 'Delivery',
            value: 'delivery',
            description: 'Deliver the order to my address'
          }
        );

      const row = new ActionRowBuilder().addComponents(select);

      return interaction.reply({
        content: '**How would you like to receive your order?**',
        components: [row],
        ephemeral: true
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'fulfillment_type') {
      const fulfillmentValue = interaction.values[0];
      const fulfillment = fulfillmentValue === 'delivery' ? 'Delivery' : 'Pick Up';
      pendingTickets.set(interaction.user.id, { fulfillment });

      const modal = new ModalBuilder().setCustomId('ticket_form').setTitle('Create Order Ticket');

      const restaurant = new TextInputBuilder()
        .setCustomId('restaurant')
        .setLabel('What Restaurant?')
        .setPlaceholder('Example: Panda Express')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const total = new TextInputBuilder()
        .setCustomId('total_price')
        .setLabel('Total Price After Fees')
        .setPlaceholder('Example: $42.67')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const payment = new TextInputBuilder()
        .setCustomId('payment_method')
        .setLabel('Payment Method - NO CA')
        .setPlaceholder('Example: Zelle')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const contact = new TextInputBuilder()
        .setCustomId('contact_info')
        .setLabel('Name + Phone Number')
        .setPlaceholder('John Smith - 314-555-0123')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const address = new TextInputBuilder()
        .setCustomId('address')
        .setLabel('Address')
        .setPlaceholder(fulfillment === 'Delivery' ? 'Street, city, state, ZIP' : 'Enter N/A for pickup')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(300);

      modal.addComponents(
        new ActionRowBuilder().addComponents(restaurant),
        new ActionRowBuilder().addComponents(total),
        new ActionRowBuilder().addComponents(payment),
        new ActionRowBuilder().addComponents(contact),
        new ActionRowBuilder().addComponents(address)
      );

      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'ticket_form') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const saved = pendingTickets.get(interaction.user.id);

        if (!saved?.fulfillment) {
          return interaction.editReply({
            content: '❌ Your ticket form expired. Please click Open Ticket again.'
          });
        }

        const existing = interaction.guild.channels.cache.find(
          c => c.topic === `ticket-user:${interaction.user.id}`
        );

        if (existing) {
          pendingTickets.delete(interaction.user.id);
          return interaction.editReply({
            content: `❌ You already have an open ticket: ${existing}`
          });
        }

        const restaurant = interaction.fields.getTextInputValue('restaurant');
        const total = interaction.fields.getTextInputValue('total_price');
        const payment = interaction.fields.getTextInputValue('payment_method');
        const contact = interaction.fields.getTextInputValue('contact_info');
        const address = interaction.fields.getTextInputValue('address');
        const fulfillment = saved.fulfillment;

        const username = interaction.user.username
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, '')
          .substring(0, 20) || 'customer';

        const orderPrefix = fulfillment === 'Delivery' ? 'delivery' : 'pickup';

        const ticketChannel = await interaction.guild.channels.create({
          name: `${orderPrefix}-${username}`,
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID || undefined,
          topic: `ticket-user:${interaction.user.id}`,
          permissionOverwrites: [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks
              ]
            },
            {
              id: ADMIN_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ManageMessages
              ]
            }
          ]
        });

        const customerName = extractNameFromContact(contact) || contact;
        const customerPhone = extractPhoneFromContact(contact) || 'Not detected';

        const embed = new EmbedBuilder()
          .setColor(0x32E875)
          .setTitle('KenDoEats Order Ticket')
          .setDescription(`Order details for ${interaction.user}`)
          .addFields(
            {
              name: 'Order Type',
              value: cleanCartValue(fulfillment),
              inline: true
            },
            {
              name: 'Restaurant',
              value: cleanCartValue(restaurant),
              inline: true
            },
            {
              name: 'Total After Fees',
              value: cleanCartValue(total),
              inline: true
            },
            {
              name: 'Payment Method',
              value: cleanCartValue(payment),
              inline: true
            },
            {
              name: 'Customer Name',
              value: cleanCartValue(customerName),
              inline: true
            },
            {
              name: 'Phone Number',
              value: cleanCartValue(customerPhone),
              inline: true
            },
            {
              name: 'Address',
              value: cleanCartValue(address),
              inline: false
            },
            {
              name: 'Discord Customer',
              value: `${interaction.user}\nID: ${interaction.user.id}`,
              inline: false
            }
          )
          .setFooter({ text: 'KenDoEats Order System' })
          .setTimestamp();

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('copy_ticket_name')
            .setLabel('Name')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_phone')
            .setLabel('Phone')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_address')
            .setLabel('Address')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_total')
            .setLabel('Total')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_payment')
            .setLabel('Payment')
            .setStyle(ButtonStyle.Secondary)
        );

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('claim_ticket')
            .setLabel('Claim Ticket')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({
          content: `<@&${ADMIN_ROLE_ID}> ${interaction.user}`,
          embeds: [embed],
          components: [copyRow, actionRow]
        });
pendingTickets.delete(interaction.user.id);

        return interaction.editReply({
          content: `✅ Your ticket has been created: ${ticketChannel}`
        });
      } catch (error) {
        console.error('TICKET CREATE ERROR:', error);

        return interaction.editReply({
          content: `❌ Couldn't create ticket. Error: ${String(error.message || error).slice(0, 400)}`
        });
      }
    }



    if (interaction.isButton() && interaction.customId.startsWith('copy_ticket_')) {
      const embed = interaction.message.embeds?.[0];

      if (!embed) {
        return interaction.reply({
          content: 'Value not found.',
          ephemeral: true
        });
      }

      const field = (needle) => {
        const match = embed.fields?.find(f =>
          String(f.name || '').toLowerCase().includes(needle.toLowerCase())
        );
        return match?.value ? String(match.value).trim() : null;
      };

      let value = null;

      if (interaction.customId === 'copy_ticket_name') {
        value = field('customer name');
      } else if (interaction.customId === 'copy_ticket_phone') {
        value = field('phone number');
      } else if (interaction.customId === 'copy_ticket_address') {
        value = field('address');
      } else if (interaction.customId === 'copy_ticket_total') {
        value = field('total after fees');
      } else if (interaction.customId === 'copy_ticket_payment') {
        value = field('payment method');
      }

      if (!value) {
        return interaction.reply({
          content: 'Value not found.',
          ephemeral: true
        });
      }

      // Only the raw value is shown to the person who clicked the button.
      // No label, quotes, backticks, code block, or extra text.
      return interaction.reply({
        content: sanitizeDisplayText(value),
        ephemeral: true
      });
    }

    if (interaction.isButton() && interaction.customId === 'claim_ticket') {
      const isChef = interaction.member.roles.cache.has(ADMIN_ROLE_ID);

      if (!isChef) {
        return interaction.reply({
          content: '❌ Only a Chef/Admin can claim this ticket.',
          ephemeral: true
        });
      }

      try {
        const safeChefName =
          interaction.user.username
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, '')
            .substring(0, 80) || 'chef';

        // Rename the ticket to the chef's Discord username.
        await interaction.channel.setName(safeChefName);

        // Disable the claim button after a successful claim.
        const claimedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('claim_ticket')
            .setLabel(`Claimed by ${interaction.user.username}`.substring(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Danger)
        );

        const claimedCopyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('copy_ticket_name')
            .setLabel('Name')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_phone')
            .setLabel('Phone')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_address')
            .setLabel('Address')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_total')
            .setLabel('Total')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('copy_ticket_payment')
            .setLabel('Payment')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({
          components: [claimedCopyRow, claimedRow]
        });

        await interaction.followUp({
          content: `👨‍🍳 ${interaction.user} claimed this ticket.`,
          allowedMentions: { users: [interaction.user.id] }
        });
      } catch (error) {
        console.error('CLAIM TICKET ERROR:', error);

        if (!interaction.replied && !interaction.deferred) {
          return interaction.reply({
            content: `❌ Couldn't claim this ticket. Error: ${String(error.message || error).slice(0, 350)}`,
            ephemeral: true
          });
        }
      }
    }

    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      const isStaff = interaction.member.roles.cache.has(ADMIN_ROLE_ID);
      const isOwner = interaction.channel.topic === `ticket-user:${interaction.user.id}`;

      if (!isStaff && !isOwner) {
        return interaction.reply({
          content: '❌ You cannot close this ticket.',
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const ticketChannel = interaction.channel;

        if (!ticketChannel || !ticketChannel.isTextBased()) {
          return interaction.editReply({
            content: '❌ This ticket channel could not be accessed.'
          });
        }

        const transcriptChannel = await interaction.guild.channels
          .fetch(TRANSCRIPT_CHANNEL_ID)
          .catch(() => null);

        if (!transcriptChannel || !transcriptChannel.isTextBased()) {
          return interaction.editReply({
            content: '❌ Transcript channel could not be found. Check TRANSCRIPT_CHANNEL_ID and bot permissions.'
          });
        }

        const messages = await fetchAllMessages(ticketChannel);
        const transcriptHtml = buildTranscriptHtml(ticketChannel, messages);
        const fileName = `${ticketChannel.name}-${ticketChannel.id}.html`;

        const attachment = new AttachmentBuilder(
          Buffer.from(transcriptHtml, 'utf8'),
          { name: fileName }
        );

        const openerId = ticketChannel.topic?.startsWith('ticket-user:')
          ? ticketChannel.topic.split(':')[1]
          : null;

        const logEmbed = new EmbedBuilder()
          .setTitle('Ticket Transcript')
          .addFields(
            { name: 'Ticket', value: `#${ticketChannel.name}`, inline: true },
            { name: 'Opened By', value: openerId ? `<@${openerId}>` : 'Unknown', inline: true },
            { name: 'Closed By', value: `${interaction.user}`, inline: true },
            { name: 'Messages', value: String(messages.length), inline: true }
          )
          .setTimestamp();

        await transcriptChannel.send({
          embeds: [logEmbed],
          files: [attachment]
        });

        await interaction.editReply({
          content: '✅ Transcript saved. Closing ticket...'
        });

        if (!ticketChannel.deletable) {
          console.error('Ticket channel is not deletable. Missing Manage Channels permission.');
          return;
        }

        await ticketChannel.delete('Ticket closed');

      } catch (error) {
        console.error('TRANSCRIPT/CLOSE ERROR:', error);

        if (!interaction.channel?.deleted) {
          return interaction.editReply({
            content: `❌ Could not close ticket. Error: ${String(error.message || error).slice(0, 400)}`
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Ticket bot error:', err);
    const msg = `❌ Something went wrong: ${err?.message || 'Unknown error'}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});



function getSupportedImageMime(attachment) {
  const type = (attachment.contentType || '').toLowerCase();

  const supported = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/heic',
    'image/heif'
  ]);

  if (supported.has(type)) {
    return type === 'image/jpg' ? 'image/jpeg' : type;
  }

  const name = (attachment.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.heic')) return 'image/heic';
  if (name.endsWith('.heif')) return 'image/heif';

  return null;
}

async function readCartScreenshotsWithGemini(attachments) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const images = Array.isArray(attachments) ? attachments : [attachments];
  const supportedImages = images
    .filter(att => getSupportedImageMime(att))
    .slice(0, 6);

  if (!supportedImages.length) return null;

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    let totalBytes = 0;
    const imageParts = [];

    for (const attachment of supportedImages) {
      if (attachment.size && attachment.size > MAX_IMAGE_BYTES) {
        throw new Error('One screenshot is too large. Keep each image under 10 MB.');
      }

      const mimeType = getSupportedImageMime(attachment);
      if (!mimeType) continue;

      const imageResponse = await fetch(attachment.url, {
        signal: controller.signal
      });

      if (!imageResponse.ok) {
        throw new Error(`Could not download one of the screenshots (${imageResponse.status})`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      if (imageBuffer.length > MAX_IMAGE_BYTES) {
        throw new Error('One screenshot is too large. Keep each image under 10 MB.');
      }

      totalBytes += imageBuffer.length;

      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('The screenshots together are too large. Please send fewer/smaller images.');
      }

      imageParts.push({
        inlineData: {
          mimeType,
          data: imageBuffer.toString('base64')
        }
      });
    }

    if (!imageParts.length) return null;

    const prompt = `Analyze ALL attached screenshots together as parts of ONE restaurant order/cart.

The screenshots may show different parts of the same cart:
- one may show the restaurant and items
- one may show item customizations/modifiers
- one may show the store address
- one may show the customer's delivery address
- one may show subtotal, tax, fees, discounts, and final total

Combine information across all screenshots into ONE result. Use details from one screenshot to fill missing details from another, but ONLY when the information is visibly present somewhere in the supplied screenshots.

Return ONLY valid JSON with this exact structure:
{
  "is_cart": true,
  "restaurant": "string or null",
  "restaurant_address": "string or null",
  "delivery_address": "string or null",
  "order_type": "string or null",
  "order_time": "string or null",
  "items": [
    {
      "quantity": "string or null",
      "name": "string or null",
      "price": "string or null",
      "specifications": ["every visible modifier/customization/add-on for this item"]
    }
  ],
  "subtotal": "visible dollar amount or null",
  "taxes_fees": "visible dollar amount or null",
  "total": "visible FINAL order total or null",
  "other": ["other useful visible order/cart information"]
}

Rules:
- Treat the screenshots as one combined evidence set.
- If they clearly appear to be unrelated orders, do not mix unrelated values.
- If none clearly show a restaurant/food cart or order summary, return {"is_cart":false}.
- Read ONLY information visibly present in the screenshots.
- Never invent or guess an address, item, customization, quantity, price, fee, restaurant name, or total.
- Capture ALL visible customizations/modifiers: sizes, flavors, toppings, removals, additions, sauces, buns, cheese, drinks, sides, cooking options, add-ons, etc.
- Keep specifications attached to the correct food item.
- If the same item appears in multiple screenshots, merge missing specifications instead of duplicating it when clearly the same item.
- Capture the restaurant/store address exactly when visible.
- Capture the customer's delivery address exactly when visible.
- Carefully distinguish store address from delivery address using labels/context.
- If an address is visible but its type is uncertain, put it in "other" instead of guessing.
- Preserve visible dollar amounts exactly.
- "total" must be the FINAL amount due/order total, not subtotal.
- If multiple totals are visible, use the one explicitly labeled as final/order total/amount due.
- Do NOT calculate the 50% discount. The bot calculates it from the detected final total.
- For unreadable text use "[unclear]".
- Return plain ASCII punctuation only.`;

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }, ...imageParts]
            }
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2600,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const payload = await apiResponse.json().catch(() => null);

    if (!apiResponse.ok) {
      const apiMessage =
        payload?.error?.message ||
        `Gemini API request failed (${apiResponse.status})`;
      throw new Error(apiMessage);
    }

    let text = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('Gemini returned no readable cart data.');
    }

    text = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Gemini returned cart data in an invalid format.');
    }

    if (!data || data.is_cart === false) {
      return null;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDetectedMoney(value) {
  if (!value) return null;

  const match = String(value)
    .replace(/,/g, '')
    .match(/-?\$?\s*(\d+(?:\.\d{1,2})?)/);

  if (!match) return null;

  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function sanitizeDisplayText(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // Common mojibake / encoding artifacts seen after UTF-8 text is mis-decoded.
  const replacements = [
    [/â€¢/g, '-'],
    [/â¢/g, '-'],
    [/â€“/g, '-'],
    [/â€”/g, '-'],
    [/â€™/g, "'"],
    [/â€œ/g, '"'],
    [/â€/g, '"'],
    [/Â/g, ''],
    [/Ã/g, ''],
    [/ðŸ[^\s]*/g, ''],
    [/�/g, '']
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  // Remove stray non-printing/control characters while preserving normal text.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Collapse accidental repeated spaces created by cleanup.
  text = text.replace(/[ \t]{2,}/g, ' ').trim();

  return text;
}

function cleanCartValue(value, fallback = 'Not detected') {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }

  const cleaned = sanitizeDisplayText(value);
  return cleaned || fallback;
}

function buildCartItemsText(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'No items detected.';
  }

  const blocks = items.slice(0, 20).map((item, index) => {
    const rawQty = cleanCartValue(item?.quantity, '1');
    const qtyMatch = rawQty.match(/\d+/);
    const qty = qtyMatch ? qtyMatch[0] : '1';

    const name = cleanCartValue(item?.name, '[unclear item]');
    const price = item?.price ? ` - ${cleanCartValue(item.price)}` : '';

    const specs = Array.isArray(item?.specifications)
      ? item.specifications
          .map(spec => sanitizeDisplayText(spec))
          .filter(Boolean)
      : [];

    let block = `${index + 1}. ${qty}x ${name}${price}`;

    if (specs.length) {
      block += `\n   ${specs.join(' | ')}`;
    }

    return block;
  });

  let text = blocks.join('\n\n');

  if (text.length > 880) {
    text = text.slice(0, 850) + '\n...more details detected.';
  }

  return text;
}




function makeTicketCopyRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('copy_ticket_name').setLabel('Copy Name').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('copy_ticket_phone').setLabel('Copy Phone').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('copy_ticket_address').setLabel('Copy Address').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('copy_ticket_total').setLabel('Copy Total').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('copy_ticket_payment').setLabel('Copy Payment').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('copy_ticket_restaurant').setLabel('Copy Restaurant').setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

function getEmbedFieldValue(embed, names) {
  if (!embed || !Array.isArray(embed.fields)) return null;
  const wanted = Array.isArray(names) ? names : [names];

  for (const field of embed.fields) {
    if (!field?.name) continue;
    const normalized = String(field.name).toLowerCase();
    if (wanted.some(name => normalized.includes(String(name).toLowerCase()))) {
      return field.value ? String(field.value) : null;
    }
  }

  return null;
}

function extractPhoneFromContact(value) {
  if (!value) return null;
  const text = sanitizeDisplayText(value);

  const match = text.match(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/
  );

  return match ? match[0].trim() : null;
}

function extractNameFromContact(value) {
  if (!value) return null;
  const text = sanitizeDisplayText(value);
  const phone = extractPhoneFromContact(text);

  let name = phone ? text.replace(phone, '') : text;

  name = name
    .replace(/^[\s|,:;-]+|[\s|,:;-]+$/g, '')
    .trim();

  return name || null;
}

function moneyFromText(value) {
  if (!value) return null;

  const match = String(value)
    .replace(/,/g, '')
    .match(/\$\s*\d+(?:\.\d{1,2})?/);

  return match ? match[0].replace(/\s+/g, '') : null;
}

async function sendCopyValue(interaction, label, value) {
  const cleaned = sanitizeDisplayText(value || '');

  if (!cleaned) {
    return interaction.reply({
      content: `Could not find ${label} in this message.`,
      ephemeral: true
    });
  }

  return interaction.reply({
    content: `**${label}**\n\`\`\`\n${cleaned.slice(0, 1800)}\n\`\`\``,
    ephemeral: true
  });
}


// ------------------------------
// UBER EATS GROUP-ORDER LINK SCANNER
// ------------------------------
const UBER_SCAN_TIMEOUT_MS = Number(process.env.UBER_SCAN_TIMEOUT_MS || 45000);
const UBER_SCAN_MAX_NETWORK_BODIES = Number(process.env.UBER_SCAN_MAX_NETWORK_BODIES || 10);
const UBER_SCAN_MAX_NETWORK_CHARS = Number(process.env.UBER_SCAN_MAX_NETWORK_CHARS || 240000);

let uberBrowser = null;
let uberBrowserLaunchPromise = null;
let uberScanQueue = Promise.resolve();

function extractUberGroupOrderUrl(text) {
  if (!text) return null;

  const match = String(text).match(
    /https?:\/\/(?:www\.)?(?:eats\.uber\.com|ubereats\.com)\/group-orders\/[0-9a-f-]{20,}\/join(?:\?[^\s<>]*)?/i
  );

  if (!match) return null;

  const candidate = match[0].replace(/[),.>]+$/g, '');

  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    const allowedHost =
      host === 'eats.uber.com' ||
      host === 'ubereats.com' ||
      host === 'www.ubereats.com';

    if (!allowedHost) return null;
    if (!/^\/group-orders\/[0-9a-f-]{20,}\/join\/?$/i.test(parsed.pathname)) return null;

    return parsed.toString();
  } catch {
    return null;
  }
}

async function getUberBrowser() {
  if (uberBrowser?.isConnected()) return uberBrowser;

  if (!uberBrowserLaunchPromise) {
    uberBrowserLaunchPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }).then(browser => {
      uberBrowser = browser;
      browser.on('disconnected', () => {
        if (uberBrowser === browser) uberBrowser = null;
      });
      return browser;
    }).finally(() => {
      uberBrowserLaunchPromise = null;
    });
  }

  return uberBrowserLaunchPromise;
}

function enqueueUberScan(task) {
  const run = uberScanQueue.then(task, task);
  uberScanQueue = run.catch(() => {});
  return run;
}

function looksLikeUberChallenge(text) {
  const value = String(text || '').toLowerCase();
  return [
    'verify you are human',
    'captcha',
    'access denied',
    'unusual activity',
    'security check',
    'checking your browser'
  ].some(phrase => value.includes(phrase));
}

function looksLikeUberLoginRequired(text) {
  const value = String(text || '').toLowerCase();
  const hasLogin = value.includes('log in') || value.includes('sign in');
  const hasGroupContext = value.includes('group order') || value.includes('join order');
  return hasLogin && hasGroupContext;
}

function trimEvidence(value, maxChars) {
  const text = sanitizeDisplayText(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[truncated]';
}

async function parseUberGroupOrderEvidenceWithGemini(evidence) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured. The Uber scanner uses Gemini to turn browser data into clean cart details.');
  }

  const prompt = `You are extracting a restaurant GROUP ORDER/CART from an Uber Eats shared group-order page.

You receive two evidence sources:
1. VISIBLE_PAGE_TEXT - strongest evidence. This is what the shared page rendered to the browser.
2. RELEVANT_NETWORK_JSON - secondary evidence from JSON responses loaded by that same page.

Return ONLY valid JSON with this exact shape:
{
  "is_cart": true,
  "access_state": "ok",
  "restaurant": "string or null",
  "restaurant_address": "string or null",
  "delivery_address": "string or null",
  "order_type": "string or null",
  "order_time": "string or null",
  "items": [
    {
      "quantity": "string or null",
      "name": "string or null",
      "price": "string or null",
      "specifications": ["modifier/customization"]
    }
  ],
  "subtotal": "visible dollar amount or null",
  "taxes_fees": "visible dollar amount or null",
  "total": "visible FINAL order total or null",
  "other": ["other useful cart/group-order details"],
  "reason": "short explanation when access_state is not ok, otherwise null"
}

Allowed access_state values:
- ok
- login_required
- expired
- challenge
- empty
- unknown

Critical rules:
- ONLY extract items that are clearly part of the shared group order/cart. Do NOT treat generic restaurant menu listings as ordered items.
- Prefer visible page text over network JSON when they conflict.
- Network JSON may contain full menu/catalog data; ignore generic menu/catalog items unless clearly attached to cart/order/group-order structures.
- Never invent quantities, modifiers, prices, addresses, fees, totals, or restaurant names.
- Never output authentication tokens, cookies, session IDs, device IDs, internal IDs, UUIDs, payment-card data, or unrelated personal data even if network data contains it.
- A final total must be explicitly identifiable as total/amount due/order total. Do not calculate a missing total.
- If the page only asks the visitor to log in/sign in before showing the group order, set is_cart=false and access_state=login_required.
- If the link/order is expired or unavailable, set is_cart=false and access_state=expired.
- If there is a bot/human verification page, set is_cart=false and access_state=challenge.
- If the group order is reachable but clearly has no ordered items, use is_cart=true and access_state=empty with an empty items array.
- If evidence is insufficient, set is_cart=false and access_state=unknown.

PAGE TITLE:
${trimEvidence(evidence.title, 500)}

FINAL URL:
${trimEvidence(evidence.finalUrl, 1000)}

VISIBLE_PAGE_TEXT:
${trimEvidence(evidence.visibleText, 45000)}

RELEVANT_NETWORK_JSON:
${trimEvidence(evidence.networkText, 55000)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2600,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error?.message || `Gemini API request failed (${response.status})`);
    }

    let text = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!text) throw new Error('Gemini returned no Uber cart data.');

    text = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function scanUberGroupOrder(groupUrl) {
  const browser = await getUberBrowser();
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  const networkBodies = [];
  let collectedNetworkChars = 0;

  page.on('response', async response => {
    try {
      if (networkBodies.length >= UBER_SCAN_MAX_NETWORK_BODIES) return;

      const responseUrl = response.url();
      const urlLower = responseUrl.toLowerCase();
      if (!urlLower.includes('uber')) return;

      const headers = response.headers();
      const contentType = String(headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('json')) return;

      const declaredLength = Number(headers['content-length'] || 0);
      if (declaredLength && declaredLength > 1500000) return;

      const body = await response.text();
      if (!body || body.length > 1500000) return;

      if (!/(group.?order|cart|checkout|restaurant|store|subtotal|total|order.?item|shopping)/i.test(body)) {
        return;
      }

      const remaining = UBER_SCAN_MAX_NETWORK_CHARS - collectedNetworkChars;
      if (remaining <= 0) return;

      const clipped = body.slice(0, Math.min(remaining, 60000));
      networkBodies.push(`URL: ${responseUrl}\n${clipped}`);
      collectedNetworkChars += clipped.length;
    } catch {
      // Some responses cannot be read after redirects/streaming. Ignore those.
    }
  });

  try {
    await page.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: UBER_SCAN_TIMEOUT_MS
    });

    await page.waitForLoadState('networkidle', { timeout: 9000 }).catch(() => {});
    await page.waitForTimeout(1800);

    // Scroll only to cause already-public lazy-loaded page content to render.
    // This scanner intentionally does not click Join, Checkout, Place order, or payment controls.
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700))).catch(() => {});
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    const title = await page.title().catch(() => '');
    const finalUrl = page.url();
    const visibleText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');

    if (looksLikeUberChallenge(visibleText)) {
      return {
        is_cart: false,
        access_state: 'challenge',
        reason: 'Uber showed a browser/human verification screen.'
      };
    }

    const parsed = await parseUberGroupOrderEvidenceWithGemini({
      title,
      finalUrl,
      visibleText,
      networkText: networkBodies.join('\n\n--- RESPONSE ---\n\n')
    });

    if (!parsed?.access_state && looksLikeUberLoginRequired(visibleText)) {
      parsed.access_state = 'login_required';
      parsed.is_cart = false;
      parsed.reason = parsed.reason || 'Uber requires a sign-in before the shared order details are visible.';
    }

    return parsed;
  } finally {
    await context.close().catch(() => {});
  }
}

function uberScanFailureText(result) {
  const state = result?.access_state || 'unknown';
  const reason = cleanCartValue(result?.reason, 'Uber did not expose enough shared-order information to read this link.');

  if (state === 'login_required') {
    return `I opened the Uber group-order link, but Uber requires a login before the shared cart details are visible. ${reason}`;
  }
  if (state === 'expired') {
    return `That Uber group-order link appears to be expired or unavailable. ${reason}`;
  }
  if (state === 'challenge') {
    return `Uber showed a browser verification/challenge page, so I could not safely read the cart automatically. ${reason}`;
  }
  if (state === 'empty') {
    return 'The Uber group order loaded, but no ordered items were visible yet.';
  }
  return `I opened the Uber link, but could not confidently extract a shared cart. ${reason}`;
}

function buildUberScanEmbed(message, cart, groupUrl) {
  const totalAmount = parseDetectedMoney(cart?.total);
  const kendoPrice = totalAmount !== null ? totalAmount * 0.5 : null;
  const savings = totalAmount !== null ? totalAmount - kendoPrice : null;

  const embed = new EmbedBuilder()
    .setColor(0x32E875)
    .setTitle('KenDoEats Uber Group Cart Scan')
    .setDescription('Automatically read from the Uber Eats group-order link.')
    .addFields(
      {
        name: 'Restaurant',
        value: cleanCartValue(cart?.restaurant),
        inline: false
      },
      {
        name: 'Items & Specifications',
        value: buildCartItemsText(cart?.items),
        inline: false
      },
      {
        name: 'Subtotal',
        value: cleanCartValue(cart?.subtotal),
        inline: true
      },
      {
        name: 'Taxes / Fees',
        value: cleanCartValue(cart?.taxes_fees),
        inline: true
      },
      {
        name: 'Original Total',
        value: cleanCartValue(cart?.total),
        inline: true
      }
    );

  if (cart?.order_type) {
    embed.addFields({ name: 'Order Type', value: cleanCartValue(cart.order_type), inline: true });
  }

  if (cart?.order_time) {
    embed.addFields({ name: 'Order Time', value: cleanCartValue(cart.order_time), inline: true });
  }

  if (kendoPrice !== null) {
    embed.addFields(
      { name: 'KenDoEats Price - 50% Off', value: `$${kendoPrice.toFixed(2)}`, inline: true },
      { name: 'You Save', value: `$${savings.toFixed(2)}`, inline: true }
    );
  }

  if (cart?.restaurant_address) {
    embed.addFields({
      name: 'Restaurant Address',
      value: cleanCartValue(cart.restaurant_address).slice(0, 1024),
      inline: false
    });
  }

  if (cart?.delivery_address) {
    embed.addFields({
      name: 'Delivery Address',
      value: cleanCartValue(cart.delivery_address).slice(0, 1024),
      inline: false
    });
  }

  if (Array.isArray(cart?.other) && cart.other.length) {
    const otherText = cart.other
      .map(value => sanitizeDisplayText(value))
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000);

    if (otherText) {
      embed.addFields({ name: 'Other Detected Details', value: otherText, inline: false });
    }
  }

  embed
    .setFooter({
      text: `Link scan for ${message.author.username} - verify details before using them`
    })
    .setTimestamp();

  return embed;
}

async function handleCustomerUberGroupLink(message) {
  const groupUrl = extractUberGroupOrderUrl(message.content);
  if (!groupUrl) return false;

  const topic = message.channel?.topic || '';
  if (!topic.startsWith('ticket-user:')) return false;

  const customerId = topic.slice('ticket-user:'.length).trim();
  if (!customerId || message.author.id !== customerId) return false;

  let statusMessage = null;

  try {
    statusMessage = await message.reply({
      content: '🔎 Scanning that Uber Eats group order automatically...',
      allowedMentions: { repliedUser: false }
    });

    const cart = await enqueueUberScan(() => scanUberGroupOrder(groupUrl));

    if (!cart || cart.is_cart === false || cart.access_state === 'challenge' || cart.access_state === 'login_required' || cart.access_state === 'expired' || cart.access_state === 'unknown') {
      await statusMessage.edit({ content: `⚠️ ${uberScanFailureText(cart)}`, embeds: [], components: [] });
      return true;
    }

    if (cart.access_state === 'empty' || !Array.isArray(cart.items) || cart.items.length === 0) {
      await statusMessage.edit({
        content: `ℹ️ ${uberScanFailureText({ ...cart, access_state: 'empty' })}`,
        embeds: [],
        components: []
      });
      return true;
    }

    const embed = buildUberScanEmbed(message, cart, groupUrl);

    await statusMessage.edit({
      content: '',
      embeds: [embed],
      components: []
    });

    return true;
  } catch (error) {
    console.error('UBER GROUP LINK SCANNER ERROR:', error);

    const errorText = String(error?.message || error).slice(0, 300);
    const content = `⚠️ I couldn't scan that Uber group-order link automatically. ${errorText}`;

    if (statusMessage) {
      await statusMessage.edit({ content, embeds: [], components: [] }).catch(() => {});
    } else {
      await message.reply({ content, allowedMentions: { repliedUser: false } }).catch(() => {});
    }

    return true;
  }
}

async function handleCustomerCartScreenshot(message) {
  // Tickets keep the original opener's Discord user ID in the channel topic.
  const topic = message.channel?.topic || '';
  if (!topic.startsWith('ticket-user:')) return false;

  const customerId = topic.slice('ticket-user:'.length).trim();

  // ONLY the customer who opened this ticket can trigger cart scanning.
  // Chef/admin/other-user images are ignored.
  if (!customerId || message.author.id !== customerId) return false;

  const supportedImages = [...message.attachments.values()]
    .filter(att => getSupportedImageMime(att))
    .slice(0, 6);

  if (!supportedImages.length) return false;

  if (!GEMINI_API_KEY) {
    console.error('CART READER: GEMINI_API_KEY is missing.');
    return false;
  }

  try {
    await message.channel.sendTyping().catch(() => {});

    const cart = await readCartScreenshotsWithGemini(supportedImages);

    // Silently ignore non-cart images.
    if (!cart) return true;

    const totalAmount = parseDetectedMoney(cart.total);
    const kendoPrice = totalAmount !== null ? totalAmount * 0.5 : null;
    const savings = totalAmount !== null ? totalAmount - kendoPrice : null;

    const locationLines = [];

    if (cart.restaurant_address) {
      locationLines.push(
        `**Restaurant Address**\n${cleanCartValue(cart.restaurant_address)}`
      );
    }

    if (cart.delivery_address) {
      locationLines.push(
        `**Delivery Address**\n${cleanCartValue(cart.delivery_address)}`
      );
    }

    const orderInfo = [];
    if (cart.order_type) orderInfo.push(`**Order Type:** ${cleanCartValue(cart.order_type)}`);
    if (cart.order_time) orderInfo.push(`**Order Time:** ${cleanCartValue(cart.order_time)}`);

    const priceLines = [
      `**Subtotal:** ${cleanCartValue(cart.subtotal)}`,
      `**Taxes / Fees:** ${cleanCartValue(cart.taxes_fees)}`,
      `**Original Total:** ${cleanCartValue(cart.total)}`
    ];

    if (kendoPrice !== null) {
      priceLines.push(
        `**KenDoEats Price (50%): $${kendoPrice.toFixed(2)}**`,
        `**You Save: $${savings.toFixed(2)}**`
      );
    } else {
      priceLines.push(
        '**KenDoEats Price:** Could not calculate because the final total was not clearly detected.'
      );
    }

    const cartEmbed = new EmbedBuilder()
      .setColor(0x32E875)
      .setTitle('KenDoEats Cart Scan')
      .setDescription('Cart details detected from the customer screenshot.')
      .addFields(
        {
          name: 'Restaurant',
          value: cleanCartValue(cart.restaurant),
          inline: false
        }
      );

    if (cart.order_type) {
      cartEmbed.addFields({
        name: 'Order Type',
        value: cleanCartValue(cart.order_type),
        inline: true
      });
    }

    if (cart.order_time) {
      cartEmbed.addFields({
        name: 'Order Time',
        value: cleanCartValue(cart.order_time),
        inline: true
      });
    }

    cartEmbed.addFields({
      name: 'Items & Specifications',
      value: buildCartItemsText(cart.items),
      inline: false
    });

    cartEmbed.addFields(
      {
        name: 'Subtotal',
        value: cleanCartValue(cart.subtotal),
        inline: true
      },
      {
        name: 'Taxes / Fees',
        value: cleanCartValue(cart.taxes_fees),
        inline: true
      },
      {
        name: 'Original Total',
        value: cleanCartValue(cart.total),
        inline: true
      }
    );

    if (kendoPrice !== null) {
      cartEmbed.addFields(
        {
          name: 'KenDoEats Price - 50% Off',
          value: `$${kendoPrice.toFixed(2)}`,
          inline: true
        },
        {
          name: 'You Save',
          value: `$${savings.toFixed(2)}`,
          inline: true
        }
      );
    } else {
      cartEmbed.addFields({
        name: 'KenDoEats Price',
        value: 'Could not calculate - final total was not clearly detected.',
        inline: false
      });
    }

    if (cart.restaurant_address) {
      cartEmbed.addFields({
        name: 'Restaurant Address',
        value: cleanCartValue(cart.restaurant_address),
        inline: false
      });
    }

    if (cart.delivery_address) {
      cartEmbed.addFields({
        name: 'Delivery Address',
        value: cleanCartValue(cart.delivery_address),
        inline: false
      });
    }

    if (Array.isArray(cart.other) && cart.other.length) {
      const otherText = cart.other
        .map(value => sanitizeDisplayText(value))
        .filter(Boolean)
        .join('\n');

      if (otherText) {
        cartEmbed.addFields({
          name: 'Other Detected Details',
          value: cleanCartValue(otherText, 'None'),
          inline: false
        });
      }
    }

    cartEmbed
      .setFooter({
        text: `Scanned from ${message.author.username}'s screenshot - Chef should verify`
      })
      .setTimestamp();

    const cartCopyRow = new ActionRowBuilder();

    if (cart.restaurant_address) {
      cartCopyRow.addComponents(
        new ButtonBuilder()
          .setCustomId('copy_cart_store_address')
          .setLabel('Store Address')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    if (cart.delivery_address) {
      cartCopyRow.addComponents(
        new ButtonBuilder()
          .setCustomId('copy_cart_delivery_address')
          .setLabel('Delivery Address')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    if (totalAmount !== null) {
      cartCopyRow.addComponents(
        new ButtonBuilder()
          .setCustomId('copy_cart_total')
          .setLabel('Total')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('copy_cart_kendo')
          .setLabel('KenDoEats Price')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const cartReply = {
      embeds: [cartEmbed],
      allowedMentions: { repliedUser: false }
    };

    if (cartCopyRow.components.length) {
      cartReply.components = [cartCopyRow];
    }

    await message.reply(cartReply);



    return true;
  } catch (error) {
    console.error('CART READER ERROR:', error);

    await message.reply({
      content: `I couldn't read that cart screenshot. ${String(error.message || error).slice(0, 250)}`,
      allowedMentions: { repliedUser: false }
    }).catch(() => {});

    return true;
  }
}


client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // UBER EATS GROUP-ORDER LINK SCANNER
  // Only the original customer in a ticket can trigger this.
  const handledUberLink = await handleCustomerUberGroupLink(message);
  if (handledUberLink) return;

  // CART SCREENSHOT READER
  // Only the original customer in a ticket can trigger this.
  const handledCartImage = await handleCustomerCartScreenshot(message);
  if (handledCartImage) return;

  // PRICE CHECK CHANNEL
  if (message.channel.id === PRICE_CHANNEL_ID) {
    const raw = message.content.trim();

    // Only respond when the entire message is a number, optionally with $ and decimals.
    if (!/^\$?\d+(?:\.\d{1,2})?$/.test(raw)) return;

    const initial = Number(raw.replace('$', ''));
    if (!Number.isFinite(initial) || initial < 0) return;

    const newPrice = initial * 0.5;
    const savings = initial - newPrice;

    const priceEmbed = new EmbedBuilder()
      .setColor(0x32E875)
      .setTitle('\u{1F3F7}\uFE0F  Price Check')
      .setDescription('Your custom KenDoEats cart quote is ready.')
      .addFields(
        {
          name: '\u{1F6D2}  Cart Total',
          value: `\`$${initial.toFixed(2)}\``,
          inline: false
        },
        {
          name: '\u{1F4B3}  Final Price',
          value: `**$${newPrice.toFixed(2)}**`,
          inline: false
        },
        {
          name: '\u{1F4B8}  You Save',
          value: `$${savings.toFixed(2)} (50% OFF)`,
          inline: false
        }
      )
      .setFooter({
        text: `Requested by ${message.author.username} • Quotes may change if the cart changes`
      })
      .setTimestamp();

    return message.reply({
      embeds: [priceEmbed],
      allowedMentions: { repliedUser: false }
    }).catch(console.error);
  }

  // VOUCH CHANNEL
  if (message.channel.id === VOUCH_CHANNEL_ID) {
    const hasImage = message.attachments.some(att => {
      const type = att.contentType || '';
      const name = (att.name || '').toLowerCase();
      return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(name);
    });

    const startsWithVouch = /^vouch\b/i.test(message.content.trim());
    const mentionedUser = message.mentions.users.first();

    if (!hasImage || !startsWithVouch || !mentionedUser) return;

    try {
      // Give the person who submitted the successful vouch the configured role.
      const member = await message.guild.members.fetch(message.author.id);
      if (!member.roles.cache.has(VOUCH_ROLE_ID)) {
        await member.roles.add(VOUCH_ROLE_ID, 'Submitted a valid KenDoEats vouch');
      }

      await message.react('❤️');
    } catch (error) {
      console.error('VOUCH ERROR:', error);
    }
  }
});

// Render Web Service health check.
// Render requires the process to bind to a port.
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('KenDoEatsTicket bot is online.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
  await client.login(TOKEN);
})();
