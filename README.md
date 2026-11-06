# openfamily-addons

Two small add-ons for a self-hosted [OpenFamily](https://github.com/NexaFlowFrance/OpenFamily) server, built for a family that wanted to **live in its notifications and its group chat** instead of opening yet another app.

| Add-on | What it does |
|---|---|
| [**Daily digest**](digest/) | One push notification every morning: today's events (including recurring ones), tasks due today, overdue tasks, the number of pending tasks, and how many items are on the shopping list. |
| [**Message intake**](intake/) | Type `#add milk, dentist Tuesday 3pm, pay water bill by the 13th` in your family's iMessage group, and it lands in OpenFamily as a shopping item, a calendar event and a task, followed by a confirmation notification. |

Both are **add-ons**: OpenFamily itself is not modified, so updating OpenFamily does not undo them. They reuse the libraries already inside OpenFamily's server image, so there is nothing extra to install and they use very little memory. They were built and tested on a 1 GB free-tier VM.

## What it looks like

**Morning digest**
```
☀️ Tuesday, Nov 3: 4 events · 3 tasks pending
📅 All day Election Day
📅 10:30 AM Dentist (Sam)
📅 4 PM Soccer practice
📅 6 PM History test
✅ Due today: Pay internet bill (Alex)
⚠️ Overdue: Renew car registration
🛒 2 items on the shopping list
```

**Message intake confirmations**
```
🛒 Added to shopping list
Bread · from Alex
```
```
Alex added 3 items
🛒 Shopping list: Rice
📅 Calendar: Orthodontist, Thu, Nov 12 4:00 PM
✅ Tasks: Pay water bill (due Fri, Nov 13)
```

## Requirements

- OpenFamily **v1.9.x** running with its standard `docker-compose.yml` (containers named `openfamily-server`, `openfamily-db`, ...).
- **Push notifications enabled** in OpenFamily (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` set in its `.env`), and turned on in each phone's OpenFamily settings. On iPhone, web push only works when OpenFamily is added to the Home Screen and opened from that icon.
- For the intake: OpenFamily's **AI assistant configured** (Settings → AI assistant; any provider works), plus a way to reach the server over **HTTPS** from your phone (Tailscale Funnel, Caddy, nginx, ...).
- `bash`, `cron` and `openssl` on the Docker host.

## Install

On the machine that runs OpenFamily:

```bash
git clone https://github.com/sub8u/openfamily-addons.git ~/openfamily-addons
cd ~/openfamily-addons

bash digest/install.sh --send-test   # preview, send one test notification, schedule daily at 7:00
bash intake/install.sh               # start the intake and print your intake key + next steps
```

Then follow [intake/IPHONE-SHORTCUT.md](intake/IPHONE-SHORTCUT.md) to connect the family group chat.

To update the add-ons later: `cd ~/openfamily-addons && git pull && bash intake/install.sh`. The digest picks up the new file on its next run.

## How it works

```
 Family iMessage group                 Your OpenFamily server
 ─────────────────────                 ──────────────────────────────────────────────
 "#add milk, dentist Tue 3pm"
        │
        ▼
 iPhone Shortcuts automation  ──HTTPS──▶  /intake  (openfamily-intake container)
 (on one parent's phone)                     │ 1. sign in as the sender
                                             │ 2. OpenFamily AI: /api/ai/parse
                                             │ 3. add items via OpenFamily's API
                                             ▼
                                         OpenFamily ──push──▶ everyone's phones
                                             ▲
 cron, every hour ───────────────────────────┘
 (openfamily-digest.js runs inside openfamily-server, sends at DIGEST_HOUR)
```

## Security notes

- The intake **signs in as the family member named in each request**, using OpenFamily's own `JWT_SECRET`. Anyone who has your **intake key** can add items to your family's OpenFamily, so treat the key like a password. The key cannot read or delete anything.
- Only messages that contain the keyword (`#add` by default) ever leave the phone. Everything else in the group chat stays private.
- The intake listens on `127.0.0.1` only; expose just the `/intake` path through your HTTPS proxy.
- Message text is sent to whichever AI provider you configured in OpenFamily, in the same way as the in-app AI button.

## Known limitations

- **Notifications go to the whole family.** OpenFamily stores every member's push registration under the family owner's account, so an add-on cannot (yet) send to one person only. Confirmations therefore reach everyone, with the sender's name included.
- The intake automation runs on **one parent's iPhone**, because iOS only triggers on *received* messages. If that phone is off, messages are not added, and that parent's own messages don't trigger it.
- Notification text is **English only** for now.
- Built against OpenFamily's database schema and API as of v1.9; a future OpenFamily release could require an update here.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the problems we actually ran into.

## License

[AGPL-3.0-only](LICENSE), the same licence as OpenFamily. Not affiliated with the OpenFamily project.
