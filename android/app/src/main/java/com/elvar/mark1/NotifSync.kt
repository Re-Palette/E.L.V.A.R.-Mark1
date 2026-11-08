package com.elvar.mark1

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Uploads notifications to the owner's relay (/api/notif) so the PC can read them. Runs inside the app (not the page), so it works while the
 * screen is closed. Every notification is encrypted on the phone first: AES-256-GCM, key = PBKDF2-SHA256(access token, "elvar-notif-v1", 100000)
 * - the same as web/src/notif-crypto.js. Off unless the owner switched it on in the settings.
 */
object NotifSync {
    private val pool = Executors.newSingleThreadExecutor()
    private var keyFor: Pair<String, SecretKeySpec>? = null

    private fun key(token: String): SecretKeySpec {
        keyFor?.let { if (it.first == token) return it.second }
        val spec = PBEKeySpec(token.toCharArray(), "elvar-notif-v1".toByteArray(Charsets.UTF_8), 100_000, 256)
        val k = SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES")
        keyFor = token to k; return k
    }

    private fun encrypt(token: String, plain: String): Pair<String, String> {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key(token), GCMParameterSpec(128, iv))
        return Base64.encodeToString(iv, Base64.NO_WRAP) to Base64.encodeToString(c.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    /** Upload whatever has not been uploaded yet (in the background). Safe to call as often as you like. */
    fun trigger(ctx: Context) {
        val app = ctx.applicationContext
        pool.execute { try { push(app) } catch (e: Exception) { /* offline: the next trigger retries from the same point */ } }
    }

    private fun push(ctx: Context) {
        val (base, token, on) = NotifStore.syncConfig(ctx)
        if (!on || base.isBlank() || token.isBlank() || !base.startsWith("https://")) return
        val after = NotifStore.syncedId(ctx)
        val all = JSONArray(NotifStore.since(ctx, after)); if (all.length() == 0) return
        val tag = NotifStore.installTag(ctx); val out = JSONArray(); var maxId = after
        for (i in 0 until minOf(all.length(), 30)) {
            val o = all.getJSONObject(i); val id = o.getLong("id")
            val plain = JSONObject().put("app", o.optString("app")).put("pkg", o.optString("pkg")).put("from", o.optString("title")).put("conversation", o.optString("conversation")).put("text", o.optString("text")).put("at", o.getLong("at")).toString()
            val (iv, ct) = encrypt(token, plain)
            out.put(JSONObject().put("id", "n$id-$tag").put("at", o.getLong("at")).put("iv", iv).put("ct", ct)); maxId = maxOf(maxId, id)
        }
        val conn = URL("$base/api/notif").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"; conn.connectTimeout = 8000; conn.readTimeout = 8000; conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json"); conn.setRequestProperty("x-elvar-token", token)
            conn.outputStream.use { it.write(JSONObject().put("items", out).toString().toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode in 200..299) { NotifStore.setSyncedId(ctx, maxId); if (all.length() > 30) push(ctx) }
        } finally { conn.disconnect() }
    }
}
