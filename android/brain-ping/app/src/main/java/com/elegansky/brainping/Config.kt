package com.elegansky.brainping

/**
 * Hardcoded config — Frank's rule: "zero setups everything hardcoded".
 * If anything moves you rebuild + reinstall the APK.
 */
object Config {
    const val BRAIN_URL = "https://elegansky-brain.onrender.com/api/phone/heartbeat"
    const val PHONE_API_KEY = "noLaiW_syb23iKYyk5Ox-sdc7H57HMU5"
    const val PHONE_NUMBER = "255752900450"   // OTP relay phone

    // 2-minute interval is battery-friendly + still well inside BRAIN's
    // 5-min stale window. Android batches "and allow while idle" alarms
    // with other system wake-ups so the actual cost is near-zero.
    const val PING_INTERVAL_MS = 120_000L

    // Stop pinging if the battery dips this low — preserves the last bit
    // of charge for OTP relay, which is the whole point of this phone.
    const val MIN_BATTERY_PCT = 10
}
