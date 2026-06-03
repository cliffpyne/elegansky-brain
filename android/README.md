# Elegansky SMS Gateway (Android)

A tiny always-on Android app that turns a phone into BRAIN's outbound SMS gateway.

## How it works

1. App runs a foreground service that polls `GET /api/notifications/pending` every 30s using `X-Phone-Key`.
2. For each returned notification, sends the message via SMS to every number in the recipient list (configured server-side at `app_settings.sms_recipients`).
3. POSTs `/api/notifications/:id/ack` to mark the row sent (or `failed` with a reason — server retries up to 5x then gives up).
4. Persists across reboots if `autoStart` is on.

## Building the APK

You don't need a local Android SDK. GitHub Actions builds the APK on every push to `android/**`:

1. Push your changes to GitHub.
2. Open the repo on github.com → Actions tab → "Build Android APK" → latest run.
3. Scroll to "Artifacts" → download `EleganskySmsGateway-debug`.
4. Unzip → `app-debug.apk`.

Manually trigger if needed: Actions → Build Android APK → "Run workflow".

## Installing

1. On the phone, enable **Install from unknown sources** for your file manager / browser.
2. Transfer `app-debug.apk` to the phone (USB, Google Drive, Telegram, etc.).
3. Tap the APK → Install.
4. Open the app, paste your **BRAIN URL** (default already filled) and **PHONE_API_KEY** (ask the operator who set it on Render).
5. Tap **Save settings** → grant the SMS + Notifications permissions when prompted → tap **Start service**.
6. Disable battery optimization for this app (Settings → Battery → optimize → find "BRAIN SMS Gateway" → Don't optimize). Otherwise Android may kill the poller after a while.

## Configuring recipient list (server-side)

Numbers are stored in BRAIN's `app_settings.sms_recipients`. Set them via the dashboard, or directly:

```bash
curl -X POST 'https://elegansky-brain.onrender.com/api/admin/sms-recipients' \
  -H 'authorization: Bearer <JWT_FROM_DASHBOARD>' \
  -H 'content-type: application/json' \
  -d '{"recipients":["+255712345678","+255787654321"]}'
```

## Testing

Fire a test notification (replace `<SECRET>` with `STATEMENT_REPORT_SECRET`):

```bash
curl -X POST 'https://elegansky-brain.onrender.com/api/notifications' \
  -H "x-report-secret: <SECRET>" \
  -H 'content-type: application/json' \
  -d '{"message":"hello from BRAIN","severity":"info","source":"test"}'
```

Within 30s the phone should send that text to every recipient.

## Severity tags in the SMS body

- `critical` → message prefixed with `[!!] `
- `warning` → prefixed with `[!] `
- `info` → no prefix
