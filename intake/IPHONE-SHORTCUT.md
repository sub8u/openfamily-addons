# Connecting a family iMessage group to the intake

The intake is triggered by an **iPhone Shortcuts automation on one parent's phone**. iOS only runs message automations for messages a phone **receives**, so that one phone listens for everyone else's `#add` messages and forwards them to your server.

You create **one automation per family member** who should be able to add items, because each automation tells the server who the sender is.

Before you start you need:
- the address of your intake, for example `https://openfamily.example.ts.net/intake`
- your **intake key** (printed by `intake/install.sh`; also `cut -d= -f2 ~/.openfamily-intake.env`)
- each family member's **OpenFamily login email**

## Create the automation (iOS 17 and later)

1. Open **Shortcuts**, go to the **Automation** tab, and tap **+**.
2. Choose **Message**, then set:
   - **Sender:** the family member (pick their contact card).
   - **Message contains:** `#add`
   - **Run immediately** (newer iOS: **Automation** on, **Confirm Before Run** off).
3. Add the action **Get Contents of URL** (newer iOS: type it in the **Search** bar at the bottom).
4. **URL:** your intake address, for example `https://openfamily.example.ts.net/intake`
5. Expand the action's options and set:
   - **Method:** `POST`
   - **Headers:** add `X-Intake-Key` set to *your intake key*
   - **Request Body:** `JSON`, with two **Text** fields:

     | Key | Value |
     |---|---|
     | `who` | the member's OpenFamily login email (typed) |
     | `text` | the blue **Message** / **Shortcut Input** variable. Pick it from the bar above the keyboard, then tap the bubble and choose **Content**. |
6. Save. Repeat for each family member.

## Test it

- Pressing ▶ in the editor runs the automation **without a message**, so the server answers `{"error":"who and text are required"}`. That is expected, and it proves the URL and key work.
- The real test is the family member sending `#add test bread` in the group chat. Within a few seconds everyone's phones should show **"🛒 Added to shopping list · Bread · from …"**.

## Tell the family

> If you want something in OpenFamily, put **#add** in the family chat: *"#add milk, dentist Tuesday 3pm"*. You'll get a notification confirming what was added.
