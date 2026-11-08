package com.elvar.mark1

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Reads (never replies to, never dismisses) notifications of the apps the owner switched on. Active only after the owner grants "Notification access". */
class ElvarNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val ctx = applicationContext
            if (sbn.packageName == ctx.packageName || sbn.packageName !in NotifStore.allowed(ctx)) return
            val n = sbn.notification
            if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return            // "3 new messages" summaries repeat the individual ones
            if (n.flags and Notification.FLAG_ONGOING_EVENT != 0) return            // calls in progress, etc.
            val ex = n.extras
            val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty().trim()
            val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty().trim()
            if (title.isBlank() && text.isBlank()) return
            val conv = ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
            val item = NotifStore.add(ctx, sbn.packageName, title.take(120), text.take(600), conv?.take(120), sbn.postTime) ?: return
            MainActivity.pushNotification(item.toString())
            NotifSync.trigger(ctx)                                                   // encrypted upload for the PC (only if the owner switched it on)
        } catch (e: Exception) { /* a malformed notification must never crash the listener */ }
    }
}
