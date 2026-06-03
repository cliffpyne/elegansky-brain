package com.elegansky.smsgateway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        val urlField = findViewById<EditText>(R.id.field_url)
        val keyField = findViewById<EditText>(R.id.field_key)
        val deviceIdField = findViewById<EditText>(R.id.field_device)
        val statusText = findViewById<TextView>(R.id.text_status)
        val btnSave = findViewById<Button>(R.id.btn_save)
        val btnStart = findViewById<Button>(R.id.btn_start)
        val btnStop = findViewById<Button>(R.id.btn_stop)

        urlField.setText(prefs.brainUrl)
        keyField.setText(prefs.apiKey)
        deviceIdField.setText(prefs.deviceId)

        btnSave.setOnClickListener {
            prefs.brainUrl = urlField.text.toString()
            prefs.apiKey = keyField.text.toString()
            prefs.deviceId = deviceIdField.text.toString()
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        }

        btnStart.setOnClickListener {
            if (!ensurePermissions()) return@setOnClickListener
            PollerService.start(this)
            Toast.makeText(this, "Started", Toast.LENGTH_SHORT).show()
        }
        btnStop.setOnClickListener {
            PollerService.stop(this)
            Toast.makeText(this, "Stopped", Toast.LENGTH_SHORT).show()
        }

        // Refresh status every second
        val handler = Handler(Looper.getMainLooper())
        val refresh = object : Runnable {
            override fun run() {
                val last = prefs.lastPollAt.let { if (it == 0L) "never" else java.text.SimpleDateFormat("HH:mm:ss").format(java.util.Date(it)) }
                statusText.text = "Status: ${prefs.lastStatus}\nLast poll: $last\nDevice: ${prefs.deviceId}"
                handler.postDelayed(this, 1000L)
            }
        }
        handler.post(refresh)
    }

    private fun ensurePermissions(): Boolean {
        val perms = mutableListOf(Manifest.permission.SEND_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = perms.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1001)
            return false
        }
        return true
    }
}
