package com.elegansky.smsgateway

import android.content.Context
import android.content.SharedPreferences

/**
 * Tiny SharedPreferences wrapper for the 4 config values:
 *  - BRAIN base URL (e.g. https://elegansky-brain.onrender.com)
 *  - Phone API key (matches PHONE_API_KEY env var on BRAIN)
 *  - Device id (logged with each ack so admin can tell which phone sent what)
 *  - Auto-start flag (start poller on boot)
 */
class Prefs(ctx: Context) {
    private val sp: SharedPreferences = ctx.getSharedPreferences("brain-sms", Context.MODE_PRIVATE)

    var brainUrl: String
        get() = sp.getString("brain_url", "https://elegansky-brain.onrender.com") ?: ""
        set(v) { sp.edit().putString("brain_url", v.trim().trimEnd('/')).apply() }

    var apiKey: String
        get() = sp.getString("api_key", "") ?: ""
        set(v) { sp.edit().putString("api_key", v.trim()).apply() }

    var deviceId: String
        get() {
            val cur = sp.getString("device_id", null)
            if (cur != null) return cur
            val newId = "phone-" + java.util.UUID.randomUUID().toString().take(8)
            sp.edit().putString("device_id", newId).apply()
            return newId
        }
        set(v) { sp.edit().putString("device_id", v.trim()).apply() }

    var autoStart: Boolean
        get() = sp.getBoolean("auto_start", true)
        set(v) { sp.edit().putBoolean("auto_start", v).apply() }

    var lastPollAt: Long
        get() = sp.getLong("last_poll_at", 0L)
        set(v) { sp.edit().putLong("last_poll_at", v).apply() }

    var lastStatus: String
        get() = sp.getString("last_status", "idle") ?: "idle"
        set(v) { sp.edit().putString("last_status", v).apply() }
}
