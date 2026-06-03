package com.elegansky.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restart PollerService on device boot if the user opted in. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (Prefs(ctx).autoStart && Prefs(ctx).apiKey.isNotBlank()) {
            PollerService.start(ctx)
        }
    }
}
