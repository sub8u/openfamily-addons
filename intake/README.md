# Message intake

Turns a short message into OpenFamily items, using OpenFamily's own AI assistant:

> **#add** rice, Sam orthodontist next Thursday 4pm, pay water bill by the 13th

becomes 🛒 *Rice* on the shopping list, 📅 *Orthodontist* on Thursday at 4 PM assigned to Sam, and ✅ *Pay water bill* due on the 13th, followed by a confirmation push:

```
Alex added 3 items
🛒 Shopping list: Rice
📅 Calendar: Orthodontist, Thu, Nov 12 4:00 PM
✅ Tasks: Pay water bill (due Fri, Nov 13)
```

A single item gets a shorter notification, such as **"🛒 Added to shopping list · Bread · from Alex"**.

## Install

```bash
bash intake/install.sh
```

The script:
- creates a random **intake key** in `~/.openfamily-intake.env` (kept across updates),
- starts the `openfamily-intake` container from OpenFamily's own server image on OpenFamily's Docker network (memory capped at 128 MB; it uses about 20 MB),
- listens on `127.0.0.1:3100` only,
- prints the key and the next steps.

Then expose it over HTTPS at `/intake`, for example with Tailscale Funnel:

```bash
sudo tailscale funnel --bg --set-path=/intake http://127.0.0.1:3100
```

Finally, connect your group chat: [IPHONE-SHORTCUT.md](IPHONE-SHORTCUT.md).

## API

`POST /intake` (any path works) with the header `X-Intake-Key: <key>` and a JSON body:

```json
{ "who": "member@example.com", "text": "#add milk and eggs" }
```

| Response | Meaning |
|---|---|
| `200 {"ok":true,"added":["🛒 Milk","🛒 Eggs"],"failed":[]}` | items added |
| `200 {"ok":true,"duplicate":true}` | the same text from the same person within 3 minutes; ignored |
| `400 who and text are required` | empty message (for example ▶ pressed in Shortcuts) |
| `401 bad key` | wrong or missing `X-Intake-Key` |
| `404 no OpenFamily account for …` | `who` doesn't match any OpenFamily login |
| `502 …` | OpenFamily's AI assistant failed (not configured, provider error, ...) |

`GET /intake` returns `{"ok":true,"service":"openfamily-intake"}` and can be used as a health check.

Any client can use the API, not only iPhone Shortcuts: an Android automation app, a Home Assistant script, an email-to-webhook service, and so on.

## Settings

| Variable | Default | |
|---|---|---|
| `INTAKE_KEYWORD` | `#add` | removed from the text before parsing |
| `INTAKE_PORT` | `3100` | |
| `OPENFAMILY_ENV` | `~/OpenFamily/.env` | OpenFamily's `.env` (install script only) |
| `OPENFAMILY_SERVER` | `openfamily-server` | server container name (install script only) |

Example: `INTAKE_KEYWORD='#of' bash intake/install.sh`

## Change the key

```bash
rm ~/.openfamily-intake.env && bash intake/install.sh
```

Then update the `X-Intake-Key` header in every automation.

## Uninstall

```bash
docker rm -f openfamily-intake
sudo tailscale funnel --set-path=/intake off   # if you used Funnel
rm ~/.openfamily-intake.env
```
