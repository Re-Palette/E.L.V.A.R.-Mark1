package com.elvar.mark1

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession

/** Fired by the assistant gesture (power-button long-press, etc.): open E.L.V.A.R. and start talking. */
class ElvarSession(context: Context) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_ASSIST)
            .putExtra(MainActivity.EXTRA_ASSISTANT, true)
        try {
            startAssistantActivity(intent)
        } catch (e: Exception) {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        hide()
    }
}
