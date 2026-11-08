package com.elvar.mark1

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** Placeholder only (Android wants one declared for an assistant). Real speech handling is in the web app via Gemini Live. */
class ElvarRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        try { listener?.error(SpeechRecognizer.ERROR_CLIENT) } catch (_: Exception) {}
    }
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}
