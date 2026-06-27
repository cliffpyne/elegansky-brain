# BrainPing — battery-friendly heartbeat APK

Tiny Android app that POSTs `{phone, battery_pct}` to BRAIN every 2 minutes so the heartbeat watcher knows the OTP-relay phone (255752900450) is alive.

## Why this is battery-friendly

- **No persistent wake lock** — phone sleeps between pings.
- **AlarmManager `setAndAllowWhileIdle`** wakes the device for one ~1 sec network call every 2 min. Android batches these with other system wake-ups so the actual cost is near-zero.
- **Foreground service notification** is `IMPORTANCE_MIN` (silent, no badge, no sound) — only there so Android doesn't kill us under Doze.
- **Skips ping if battery <10%** so the last juice goes to OTP relay.
- **Wi-Fi or mobile data agnostic** — uses whatever's available; one TLS POST is ~5 KB.

## What to do with it

1. Push to GitHub — the `.github/workflows/build-android-apk.yml` action builds a debug APK.
2. Download the APK from the GitHub Action artifacts.
3. Sideload onto the OTP phone (Settings → Security → Install unknown apps).
4. Open the app once — it starts the service, the notification appears.
5. Reboot the phone if you want to verify boot-restart works.

## Where to look on the phone

- Pull down notifications → see `BRAIN Ping · HH:MM:SS · OK · battery 87%`.
- If status shows `FAIL <code>` repeatedly, BRAIN URL or PHONE_API_KEY is wrong → rebuild with corrected `Config.kt`.
