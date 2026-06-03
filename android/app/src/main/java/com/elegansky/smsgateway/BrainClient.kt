package com.elegansky.smsgateway

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Minimal HTTP client for BRAIN's notification endpoints.
 * Uses HttpURLConnection so no external HTTP lib is needed.
 *
 * Endpoints:
 *   GET  /api/notifications/pending      → claim pending rows
 *   POST /api/notifications/:id/ack      → mark sent/failed
 */
data class PendingNotification(
    val id: String,
    val message: String,
    val severity: String,
    val source: String,
    val createdAt: String,
    val smsTo: List<String>,
)

data class PendingResponse(
    val recipients: List<String>,
    val pending: List<PendingNotification>,
)

class BrainClient(private val prefs: Prefs) {

    fun fetchPending(): PendingResponse {
        val url = URL("${prefs.brainUrl}/api/notifications/pending")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("x-phone-key", prefs.apiKey)
            setRequestProperty("Accept", "application/json")
            connectTimeout = 15000
            readTimeout = 20000
        }
        try {
            val code = conn.responseCode
            val body = BufferedReader(InputStreamReader(
                if (code in 200..299) conn.inputStream else conn.errorStream
            )).use { it.readText() }
            if (code !in 200..299) throw RuntimeException("HTTP $code: ${body.take(200)}")
            val obj = JSONObject(body)
            val recipients = obj.optJSONArray("recipients")?.toStringList() ?: emptyList()
            val pendingArr = obj.optJSONArray("pending") ?: JSONArray()
            val pending = (0 until pendingArr.length()).map {
                val it_ = pendingArr.getJSONObject(it)
                PendingNotification(
                    id = it_.optString("id"),
                    message = it_.optString("message"),
                    severity = it_.optString("severity"),
                    source = it_.optString("source"),
                    createdAt = it_.optString("created_at"),
                    smsTo = it_.optJSONArray("sms_to")?.toStringList() ?: emptyList(),
                )
            }
            return PendingResponse(recipients, pending)
        } finally {
            conn.disconnect()
        }
    }

    fun ack(id: String, status: String, failureReason: String? = null) {
        val url = URL("${prefs.brainUrl}/api/notifications/$id/ack")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("x-phone-key", prefs.apiKey)
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            doOutput = true
            connectTimeout = 15000
            readTimeout = 20000
        }
        try {
            val body = JSONObject().apply {
                put("status", status)
                put("device_id", prefs.deviceId)
                if (failureReason != null) put("failure_reason", failureReason)
            }.toString()
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = BufferedReader(InputStreamReader(conn.errorStream)).use { it.readText() }
                throw RuntimeException("ack HTTP $code: ${err.take(200)}")
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun JSONArray.toStringList(): List<String> =
        (0 until length()).map { getString(it) }
}
