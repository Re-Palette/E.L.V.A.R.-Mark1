package com.elvar.mark1

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Device-local buffer of notifications from the apps the owner chose (LINE / Instagram / Messenger by default).
 * Nothing leaves the phone from here: the web app reads this buffer through the bridge only when the owner asks.
 */
object NotifStore {
    private const val PREFS = "elvar_notif"
    private const val MAX = 100
    /** package -> name shown to the owner. Only these can be switched on. */
    val KNOWN = linkedMapOf(
        "jp.naver.line.android" to "LINE",
        "com.instagram.android" to "Instagram",
        "com.facebook.orca" to "Messenger",
    )

    @Synchronized fun allowed(ctx: Context): Set<String> {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = sp.getString("allowed", null) ?: return KNOWN.keys.toSet()      // default: the three apps the owner asked for
        return try { val a = JSONArray(raw); (0 until a.length()).map { a.getString(it) }.filter { it in KNOWN }.toSet() } catch (e: Exception) { KNOWN.keys.toSet() }
    }

    @Synchronized fun setAllowed(ctx: Context, pkg: String, on: Boolean) {
        if (pkg !in KNOWN) return
        val cur = allowed(ctx).toMutableSet(); if (on) cur.add(pkg) else cur.remove(pkg)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("allowed", JSONArray(cur.toList()).toString()).apply()
    }

    @Synchronized private fun load(ctx: Context): JSONArray =
        try { JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("items", "[]")) } catch (e: Exception) { JSONArray() }

    /** @return the stored item (with its id), or null if it was a duplicate. */
    @Synchronized fun add(ctx: Context, pkg: String, title: String, text: String, conversation: String?, at: Long): JSONObject? {
        val items = load(ctx)
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        for (i in maxOf(0, items.length() - 8) until items.length()) {                       // the same notification is often posted twice
            val o = items.getJSONObject(i)
            if (o.optString("pkg") == pkg && o.optString("title") == title && o.optString("text") == text && at - o.optLong("at") < 15000) return null
        }
        val id = sp.getLong("nextId", 1L)
        val item = JSONObject().put("id", id).put("pkg", pkg).put("app", KNOWN[pkg] ?: pkg).put("title", title).put("text", text).put("at", at)
        if (!conversation.isNullOrBlank()) item.put("conversation", conversation)
        items.put(item)
        val out = JSONArray(); for (i in maxOf(0, items.length() - MAX) until items.length()) out.put(items.get(i))
        sp.edit().putString("items", out.toString()).putLong("nextId", id + 1).apply()
        return item
    }

    @Synchronized fun since(ctx: Context, afterId: Long): String {
        val items = load(ctx); val out = JSONArray()
        for (i in 0 until items.length()) if (items.getJSONObject(i).optLong("id") > afterId) out.put(items.get(i))
        return out.toString()
    }

    @Synchronized fun clear(ctx: Context) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("items", "[]").apply() }

    // ---- cloud relay settings (set by the web app) and how far we have uploaded
    @Synchronized fun setSync(ctx: Context, baseUrl: String, token: String, enabled: Boolean) {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val wasOn = sp.getBoolean("syncOn", false)
        val e = sp.edit().putString("syncUrl", baseUrl.trimEnd('/')).putString("syncToken", token).putBoolean("syncOn", enabled)
        if (enabled && !wasOn) e.putLong("syncedId", sp.getLong("nextId", 1L) - 1)       // switching it on sends NEW notifications only, not the old ones already stored
        e.apply()
    }
    @Synchronized fun syncConfig(ctx: Context): Triple<String, String, Boolean> {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Triple(sp.getString("syncUrl", "") ?: "", sp.getString("syncToken", "") ?: "", sp.getBoolean("syncOn", false))
    }
    @Synchronized fun syncedId(ctx: Context): Long = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("syncedId", 0L)
    @Synchronized fun setSyncedId(ctx: Context, id: Long) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("syncedId", id).apply() }
    /** A short random tag of this install, so ids from two phones can never collide in the relay. */
    @Synchronized fun installTag(ctx: Context): String {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return sp.getString("tag", null) ?: java.util.UUID.randomUUID().toString().take(8).also { sp.edit().putString("tag", it).apply() }
    }

    fun appsJson(ctx: Context): String {
        val on = allowed(ctx); val a = JSONArray()
        for ((pkg, name) in KNOWN) a.put(JSONObject().put("pkg", pkg).put("name", name).put("on", pkg in on))
        return a.toString()
    }
}
