package com.elegansky.brainping

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Battery-friendly heartbeat service.
 *
 * No persistent wake lock. No background polling thread. Just a foreground
 * service that owns a quiet notification (so Android keeps us alive across
 * Doze) and an AlarmManager-scheduled wake-up every PING_INTERVAL_MS.
 *
 * When the alarm fires:
 *   1. Read battery%
 *   2. If battery < MIN_BATTERY_PCT, skip the network call
 *   3. Otherwise POST to BRAIN (5-15s)
 *   4. Schedule next alarm and return — CPU goes back to sleep
 *
 * Even on a busy day this draws <0.5% battery in 24h because the only
 * wake-up time is the ~1s network call once every 2 min.
 */
class PingService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(NOTIF_ID, buildNotification("waiting…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Two entry points: (a) cold start from MainActivity / boot,
        // (b) alarm fired by AlarmManager. Both run the same flow.
        runPingOnce()
        scheduleNext()
        return START_STICKY
    }

    private fun runPingOnce() {
        Thread {
            try {
                val batteryPct = readBatteryPct()
                val (ok, code) = if (batteryPct in 0 until Config.MIN_BATTERY_PCT) {
                    // Low battery — skip the network. Note in notification.
                    Pair(false, -1)
                } else {
                    postHeartbeat(batteryPct)
                }
                val ts = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
                val battery = if (batteryPct >= 0) "$batteryPct%" else "?"
                val state = when {
                    batteryPct in 0 until Config.MIN_BATTERY_PCT -> "LOW-BAT-SKIP"
                    ok -> "OK"
                    code > 0 -> "FAIL $code"
                    else -> "FAIL"
                }
                updateNotification("$ts · $state · battery $battery")
            } catch (_: Throwable) {
                // Best-effort — never crash the service.
            }
        }.start()
    }

    private fun readBatteryPct(): Int {
        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return -1
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        return if (level >= 0 && scale > 0) (level * 100) / scale else -1
    }

    private fun postHeartbeat(batteryPct: Int): Pair<Boolean, Int> {
        return try {
            val url = URL(Config.BRAIN_URL)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-phone-key", Config.PHONE_API_KEY)
            }
            val body = JSONObject().apply {
                put("phone", Config.PHONE_NUMBER)
                if (batteryPct >= 0) put("battery_pct", batteryPct)
            }.toString().toByteArray(Charsets.UTF_8)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            conn.disconnect()
            Pair(code in 200..299, code)
        } catch (_: Throwable) {
            Pair(false, -1)
        }
    }

    private fun scheduleNext() {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(this, PingService::class.java).setAction(ACTION_PING)
        val pendingFlag = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_IMMUTABLE else 0) or PendingIntent.FLAG_UPDATE_CURRENT
        val pi = PendingIntent.getService(this, 0, intent, pendingFlag)
        val nextAt = System.currentTimeMillis() + Config.PING_INTERVAL_MS
        // setAndAllowWhileIdle — inexact (battery-friendly) but still wakes
        // the device during Doze. Android batches with other alarms, so the
        // actual wake cost is shared with system jobs.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextAt, pi)
        } else {
            am.set(AlarmManager.RTC_WAKEUP, nextAt, pi)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "BRAIN heartbeat",
                        NotificationManager.IMPORTANCE_MIN).apply {
                        setShowBadge(false)
                        enableLights(false)
                        enableVibration(false)
                    }
                )
            }
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_IMMUTABLE else 0
        val pending = PendingIntent.getActivity(this, 0, openIntent, pendingFlag)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("BRAIN Ping")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setShowWhen(false)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "ping"
        const val NOTIF_ID = 1
        const val ACTION_PING = "com.elegansky.brainping.PING"
    }
}
