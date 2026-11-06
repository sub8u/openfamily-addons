# Troubleshooting

Real problems we hit while setting this up, and their fixes.

## The automation doesn't fire

Check the server log first: `docker logs --tail 10 openfamily-intake`. If no new `processed` line appears after a family member sends an `#add` message, the iPhone automation did not run.

- **The sender doesn't match the contact.** iMessage can send from a phone number **or** an Apple ID email. If the address the messages come from isn't on that person's contact card, "Sender is …" never matches. In Messages, tap the person's name to see which address they message from, and add it to their contact card. Also watch for **several contacts with similar names**: the automation must point at the card that holds the right number or email.
- **To see whether it fires at all**, temporarily add a **Show Notification** action before *Get Contents of URL*. Remove it once things work.
- After restarting the phone, some automations only run once it has been unlocked.

## "who and text are required"

This is expected when you press ▶ in the Shortcuts editor, because there is no message. Test with a real message instead.

## "no OpenFamily account for …"

The `who` email in the automation must exactly match the member's **OpenFamily login email**.

## "The network connection was lost" in Shortcuts

This is usually a brief network drop on the phone, especially on weak cellular. Check the server: `curl -s https://YOUR-ADDRESS/intake` should return `{"ok":true,"service":"openfamily-intake"}`.

## Items are added, but nobody gets a notification

- Run this on the server to see which accounts have registered devices:
  ```bash
  docker exec openfamily-db psql -U openfamily -d openfamily -c "SELECT u.email, count(p.id) AS devices FROM users u LEFT JOIN push_subscriptions p ON p.user_id = u.id GROUP BY u.email;"
  ```
  It is **normal** for every device to be listed under the family **owner**: OpenFamily stores all members' registrations there. The intake sends to all of them.
- If the owner shows `0`, nobody has enabled notifications. On each phone, open OpenFamily **from the Home Screen icon** (on iPhone, web push does not work from a Safari tab), go to Settings, and turn notifications on.
- Check that `VAPID_*` is set in OpenFamily's `.env`, and run `docker logs openfamily-intake` to look for `push failed`.

## The notification switch looks on, but a phone gets nothing

OpenFamily's notification switch only checks whether the *browser* is registered. Turn it **off and on again** in OpenFamily's settings to register afresh.

## AI-created items come out in French

OpenFamily's AI instructions are written in French, and some models reply in French ("Rappel : …", "Rendez-vous dentiste"). This is an OpenFamily issue, not an add-on issue. A one-line workaround is to add an instruction to keep the user's language in `server/src/services/ai/assistant.ts` (in `buildParsePrompt`) and rebuild the server. It has to be re-applied after each OpenFamily update.

## The digest isn't arriving

- Run `tail ~/openfamily-digest.log`. Lines like `local hour is 6, not 7; nothing to do` are normal: the job runs hourly and only sends at `DIGEST_HOUR`.
- To preview without sending: `docker exec -i -e DIGEST_FORCE=1 -e DIGEST_DRY_RUN=1 -w /app openfamily-server node - < digest/openfamily-digest.js`
- The send time follows OpenFamily's `TZ` setting. If `TZ` isn't set, the container uses UTC.

## After updating OpenFamily

Re-run `bash intake/install.sh` so the intake runs on the new server image. The digest needs nothing.
