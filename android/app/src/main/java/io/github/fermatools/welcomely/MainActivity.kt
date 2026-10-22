package io.github.fermatools.welcomely

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Casca nativa do Welcomely: abre o app web (servido pelo servidor Welcomely) numa WebView.
 * Links externos (WhatsApp, telefone, e-mail) abrem nos apps do aparelho.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var errorView: View

    private val prefs by lazy { getSharedPreferences("welcomely", MODE_PRIVATE) }

    private val serverUrl: String
        get() = normalize(prefs.getString(KEY_SERVER, null) ?: BuildConfig.SERVER_URL)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            setBackgroundColor(Color.TRANSPARENT)
            addJavascriptInterface(Bridge(), "WelcomelyAndroid")
            webViewClient = Client()
        }
        errorView = buildErrorView()

        val root = FrameLayout(this).apply {
            addView(webView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            addView(errorView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        // Mantém o conteúdo fora das barras do sistema e acima do teclado.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else load()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    private fun load() {
        errorView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(serverUrl)
    }

    private fun isAppUrl(uri: Uri): Boolean {
        val server = Uri.parse(serverUrl)
        return uri.scheme in listOf("http", "https") && uri.host == server.host && uri.port == server.port
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show()
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isAppUrl(request.url)) return false
            openExternal(request.url)
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                webView.visibility = View.INVISIBLE
                errorView.visibility = View.VISIBLE
            }
        }
    }

    /** Funções disponíveis para o app web em window.WelcomelyAndroid. */
    inner class Bridge {
        @JavascriptInterface
        fun share(title: String, url: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, title)
                    putExtra(Intent.EXTRA_TEXT, "$title\n$url")
                }
                startActivity(Intent.createChooser(send, getString(R.string.share_via)))
            }
        }

        @JavascriptInterface
        fun configureServer() {
            runOnUiThread { showServerDialog() }
        }

        @JavascriptInterface
        fun serverUrl(): String = serverUrl
    }

    private fun showServerDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(serverUrl)
            hint = getString(R.string.server_hint)
            setSelectAllOnFocus(true)
        }
        val box = FrameLayout(this).apply {
            val pad = dp(20)
            setPadding(pad, dp(8), pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.server_settings)
            .setView(box)
            .setPositiveButton(R.string.save) { _, _ ->
                val value = input.text.toString().trim()
                if (value.isNotEmpty()) prefs.edit().putString(KEY_SERVER, normalize(value)).apply()
                load()
            }
            .setNeutralButton(R.string.restore_default) { _, _ ->
                prefs.edit().remove(KEY_SERVER).apply()
                load()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun buildErrorView(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        visibility = View.GONE
        val pad = dp(32)
        setPadding(pad, pad, pad, pad)
        addView(TextView(context).apply {
            setText(R.string.error_title)
            textSize = 20f
            setTextColor(getColor(R.color.brand))
            gravity = Gravity.CENTER
        })
        addView(TextView(context).apply {
            setText(R.string.error_message)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(24))
        })
        addView(Button(context).apply {
            setText(R.string.retry)
            setOnClickListener { load() }
        })
        addView(Button(context, null, android.R.attr.borderlessButtonStyle).apply {
            setText(R.string.server_settings)
            setOnClickListener { showServerDialog() }
        })
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_SERVER = "server_url"

        private fun normalize(url: String): String {
            var u = url.trim()
            if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
            return if (u.endsWith("/")) u else "$u/"
        }
    }
}
