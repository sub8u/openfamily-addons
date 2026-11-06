# Daily digest

One push notification per morning to every registered device in the family:

```
☀️ Tuesday, Nov 3: 4 events · 3 tasks pending
📅 All day Election Day
📅 10:30 AM Dentist (Sam)
✅ Due today: Pay internet bill (Alex)
⚠️ Overdue: Renew car registration
🛒 2 items on the shopping list
```

- **Events:** everything on today's calendar, including recurring events, in time order, with the family members they're assigned to. Skipped occurrences of recurring events are respected.
- **Tasks:** due today and overdue are listed. The count in the title is *all* unfinished tasks, including ones with no due date.
- If there are more than 8 lines, it shows the first 8 plus "…and N more in the app". Tapping the notification opens OpenFamily.

## Install

```bash
bash digest/install.sh --send-test
```

This prints a preview, sends one real notification, and adds an hourly cron job that only sends at `DIGEST_HOUR` (default 7) in OpenFamily's time zone.

Use a different hour: `DIGEST_HOUR=6 bash digest/install.sh`

## Run by hand

```bash
# preview only
docker exec -i -e DIGEST_FORCE=1 -e DIGEST_DRY_RUN=1 -w /app openfamily-server node - < digest/openfamily-digest.js
# send now
docker exec -i -e DIGEST_FORCE=1 -w /app openfamily-server node - < digest/openfamily-digest.js
```

## How it works

The script is piped into the running `openfamily-server` container, where it uses that container's `pg` and `web-push` libraries, its database credentials and VAPID keys, and OpenFamily's own recurring-event logic (`server/dist/lib/appointmentRecurrence.js`). It reads the database, builds the message, sends it, and exits. Nothing keeps running between digests.

## Uninstall

```bash
crontab -l | grep -v openfamily-digest | crontab -
```
