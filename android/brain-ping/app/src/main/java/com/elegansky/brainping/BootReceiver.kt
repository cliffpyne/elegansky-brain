package com.elegansky.brainping

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** Re-starts the heartbeat service after a reboot so Frank never has to open the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action !in setOf(
                Intent.ACTION_BOOT_COMPLETED,
                "android.intent.action.QUICKBOOT_POWERON")) return
        val svc = Intent(context, PingService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(svc)
        } else {
            context.startService(svc)
        }
    }
}
