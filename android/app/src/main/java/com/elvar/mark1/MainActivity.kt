package com.elvar.mark1

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContentValues
import android.content.IntentFilter
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.app.Activity

class MainActivity : Activity() {
    companion object {
        const val EXTRA_ASSISTANT = "assistant"
        private var current: java.lang.ref.WeakReference<MainActivity>? = null
        /** Called by the notification listener: hand a new notification to the page if it is open (otherwise it waits in NotifStore). */
        fun pushNotification(json: String) {
            val a = current?.get() ?: return
            a.runOnUiThread { try { a.web.evaluateJavascript("window.__elvarNotif&&window.__elvarNotif($json)", null) } catch (e: Exception) {} }
        }
    }

    lateinit var web: WebView
    private lateinit var prefs: SharedPreferences
    private var pendingPermission: PermissionRequest? = null
    private var baseUrl: String = ""
    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) { pushLocked(false) }     // user unlocked while the app is open: personal tools may run
    }
    private fun isLocked() = (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
    private fun pushLocked(v: Boolean) { web.evaluateJavascript("window.__elvarLocked&&window.__elvarLocked($v)", null) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    /** The web app cannot download blobs inside a WebView: it hands files (PDF documents) to us, and we put them in Downloads. */
    inner class AndroidBridge {
        // ---- notifications (LINE / Instagram / Messenger ...): the owner grants access in Android settings and chooses the apps
        @JavascriptInterface fun notifAccess(): Boolean =
            (android.provider.Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: "").contains(packageName)
        @JavascriptInterface fun openNotifSettings() {
            try { startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}
        }
        @JavascriptInterface fun getNotifications(afterId: Long): String = NotifStore.since(applicationContext, afterId)
        @JavascriptInterface fun getNotifApps(): String = NotifStore.appsJson(applicationContext)
        @JavascriptInterface fun setNotifApp(pkg: String, on: Boolean) { NotifStore.setAllowed(applicationContext, pkg, on) }
        @JavascriptInterface fun setSyncConfig(baseUrl: String, token: String, enabled: Boolean) { NotifStore.setSync(applicationContext, baseUrl, token, enabled); if (enabled) NotifSync.trigger(applicationContext) }
        @JavascriptInterface fun clearNotifications() { NotifStore.clear(applicationContext) }

        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String): Boolean {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(100).ifBlank { "document.pdf" }
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
                runOnUiThread { Toast.makeText(this@MainActivity, "ダウンロードに保存しました：$safe", Toast.LENGTH_LONG).show() }
                true
            } catch (e: Exception) { false }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("elvar", MODE_PRIVATE)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        current = java.lang.ref.WeakReference(this)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false      // the greeting / voice must play without a tap
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        web.addJavascriptInterface(AndroidBridge(), "ElvarAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = Uri.parse(baseUrl).host
                if (request.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url)); return true      // other sites open in the browser
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // <input type=file> (the MP3 picker in the settings panel) needs this in a WebView, otherwise the button does nothing.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), 2)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (!wantsMic) { request.deny(); return }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingPermission = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
                }
            }
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }
        registerReceiver(unlockReceiver, IntentFilter(Intent.ACTION_USER_PRESENT))
        open(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        open(intent)
    }

    /** Resolve the E.L.V.A.R. URL (build-time, else saved, else ask once) and load it. */
    private fun open(intent: Intent?) {
        val voiceActions = setOf(Intent.ACTION_ASSIST, Intent.ACTION_VOICE_COMMAND, "android.speech.action.VOICE_SEARCH_HANDS_FREE", Intent.ACTION_SEARCH_LONG_PRESS)
        val assistant = intent?.action in voiceActions || intent?.getBooleanExtra(EXTRA_ASSISTANT, false) == true
        val url = BuildConfig.ELVAR_URL.ifBlank { prefs.getString("url", "") ?: "" }
        if (url.isBlank()) { askUrl(assistant); return }
        load(url, assistant)
    }

    private fun load(url: String, assistant: Boolean) {
        baseUrl = url
        val u = Uri.parse(url).buildUpon()
        if (assistant) u.appendQueryParameter("assistant", "1")
        if (isLocked()) u.appendQueryParameter("locked", "1")      // opened over the lock screen: the web app keeps personal data off until unlock
        web.loadUrl(u.build().toString())
    }

    private fun askUrl(assistant: Boolean) {
        val input = EditText(this).apply { hint = "https://（デプロイ先のURL）"; setSingleLine() }
        AlertDialog.Builder(this)
            .setTitle("E.L.V.A.R. のURL")
            .setMessage("デプロイ先のURLを入力してください（初回のみ）。")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("開く") { _, _ ->
                var v = input.text.toString().trim()
                if (v.isNotEmpty()) {
                    if (!v.startsWith("http")) v = "https://$v"
                    prefs.edit().putString("url", v).apply()
                    load(v, assistant)
                } else finish()
            }
            .setNegativeButton("閉じる") { _, _ -> finish() }
            .show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingPermission?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        pendingPermission = null
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 2) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    override fun onPause() { super.onPause(); web.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onDestroy() { try { unregisterReceiver(unlockReceiver) } catch (_: Exception) {}; web.destroy(); super.onDestroy() }
}
