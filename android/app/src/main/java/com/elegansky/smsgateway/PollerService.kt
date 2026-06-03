package com.elegansky.smsgateway

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.telephony.SmsManager
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*

/**
 * Long-running foreground service that polls BRAIN every POLL_INTERVAL_MS and
 * forwards each pending notification as SMS to the configured recipients.
 *
 * Lifecycle:
 *   start  → PollerService.start(context)
 *   stop   → PollerService.stop(context)
 *   reboot → BootReceiver auto-starts if prefs.autoStart is true
 */
class PollerService : Service() {

    companion object {
        const val NOTIF_CHANNEL = "brain-sms-gateway"
        const val NOTIF_ID = 1
        const val POLL_INTERVAL_MS = 30_000L
        private const val TAG = "PollerService"

        fun start(ctx: Context) {
            val intent = Intent(ctx, PollerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, PollerService::class.java)) }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pollJob: Job? = null
    private lateinit var prefs: Prefs
    private lateinit var client: BrainClient
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        client = BrainClient(prefs)
        createChannel()
        startForeground(NOTIF_ID, buildNotification("Starting…"))
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BrainSms:poller").apply {
            setReferenceCounted(false); acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (pollJob?.isActive != true) {
            pollJob = scope.launch { pollLoop() }
        }
        return START_STICKY
    }

    private suspend fun pollLoop() {
        while (currentCoroutineContext().isActive) {
            try {
                val resp = client.fetchPending()
                prefs.lastPollAt = System.currentTimeMillis()
                if (resp.pending.isEmpty()) {
                    prefs.lastStatus = "idle (0 pending)"
                    updateNotification("Idle — ${prefs.lastPollAt.toTimeString()}")
                } else {
                    prefs.lastStatus = "sending ${resp.pending.size} SMS"
                    updateNotification("Sending ${resp.pending.size}…")
                    val recipients = resp.recipients
                    for (n in resp.pending) {
                        handleOne(n, recipients)
                    }
                    prefs.lastStatus = "${resp.pending.size} sent"
                }
            } catch (e: Exception) {
                Log.e(TAG, "poll failed", e)
                prefs.lastStatus = "err: ${e.message?.take(80)}"
                updateNotification("Err: ${e.message?.take(60)}")
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    private fun handleOne(n: PendingNotification, recipients: List<String>) {
        val targets = if (n.smsTo.isNotEmpty()) n.smsTo else recipients
        if (targets.isEmpty()) {
            try { client.ack(n.id, "failed", "no recipients configured") } catch (_: Exception) {}
            return
        }
        try {
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                getSystemService(SmsManager::class.java)!!
            else
                @Suppress("DEPRECATION") SmsManager.getDefault()
            val tag = when (n.severity) { "critical" -> "[!!] "; "warning" -> "[!] "; else -> "" }
            val body = (tag + n.message).take(800) // multipart will handle long messages
            for (number in targets) {
                val parts = smsManager.divideMessage(body)
                smsManager.sendMultipartTextMessage(number, null, parts, null, null)
            }
            client.ack(n.id, "sent")
        } catch (e: Exception) {
            Log.e(TAG, "send failed for ${n.id}", e)
            try { client.ack(n.id, "failed", e.message ?: "sms error") } catch (_: Exception) {}
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(NOTIF_CHANNEL, "BRAIN SMS Gateway", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(NotificationManager::class.java)).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val builder = NotificationCompat.Builder(this, NOTIF_CHANNEL)
            .setContentTitle("BRAIN SMS Gateway")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        return builder.build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun Long.toTimeString(): String {
        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
        return sdf.format(java.util.Date(this))
    }
}
