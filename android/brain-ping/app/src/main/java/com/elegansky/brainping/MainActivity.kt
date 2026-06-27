package com.elegansky.brainping

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Inline layout — no resources needed. Frank's rule: zero setups.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 96, 48, 48)
            setBackgroundColor(0xFF060912.toInt())   // matches PikiPiki bg
        }
        val title = TextView(this).apply {
            text = "BRAIN PING"
            textSize = 28f
            setTextColor(0xFF10B981.toInt())          // green accent
            gravity = Gravity.CENTER
        }
        val sub = TextView(this).apply {
            text = "Every 2 min · battery-friendly\n${Config.PHONE_NUMBER}"
            textSize = 14f
            setTextColor(0xFF94A3B8.toInt())          // slate
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 32)
        }
        val status = TextView(this).apply {
            text = "Service started. Pull down notifications to see last ping status."
            textSize = 13f
            setTextColor(0xFF94A3B8.toInt())
            gravity = Gravity.CENTER
            ellipsize = TextUtils.TruncateAt.END
        }
        root.addView(title)
        root.addView(sub)
        root.addView(status)
        setContentView(root)

        // Start the foreground service. Safe to call repeatedly.
        val intent = Intent(this, PingService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }
}
