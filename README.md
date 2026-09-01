# KenDoEats Discord Bot

A Discord ticket bot with order tickets, private transcripts, price checks,
vouches, cart screenshot reading, and passive Uber Eats group-order link scans.
It does not place Uber orders or submit payments.

## 1. Create the Discord application

1. Open the Discord Developer Portal and create an application.
2. Open **Bot**, create/reset the token, and copy it somewhere private.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent** and
   **Message Content Intent**.
4. Copy the **Application ID** from **General Information**.

Never paste the bot token into chat or commit it to GitHub.

## 2. Prepare the new server

Enable Discord Developer Mode under **User Settings > Advanced**. Create:

- a staff role;
- a ticket category;
- a private transcript text channel;
- a price-check text channel;
- a vouch text channel;
- a role to award after a valid vouch.

Right-click the server, channels, category, and roles and choose **Copy ID**.
The bot's role must be above the vouch role in **Server Settings > Roles**.

## 3. Configure locally

Requires Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Fill every required value in `.env`. `GEMINI_API_KEY` is optional; without it,
image and Uber-link interpretation are unavailable, while normal tickets,
transcripts, price checks, and vouches still work.

Generate the least-privilege invite URL:

```powershell
npm run invite
```

Open the printed URL and add the bot to the configured server.

## 4. Run

```powershell
npm run check
npm start
```

After the bot logs in, use `/ticketpanel` in the channel where customers should
open tickets. Slash commands are registered directly to `GUILD_ID`, so they
normally appear immediately.

## Hosting

The included Dockerfile works on container hosts. Add the same `.env` values as
private environment variables in the host dashboard. Do not upload `.env`,
`.uber-browser-profile`, or `uber-discovery`; all are excluded from Git.

Uber flow-discovery details are in `DISCOVERY-README.md`.

