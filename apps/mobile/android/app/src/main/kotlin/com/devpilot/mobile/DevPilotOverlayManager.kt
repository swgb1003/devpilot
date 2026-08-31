package com.devpilot.mobile

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * A deliberately small native overlay. It remains visible while another app
 * is foregrounded, so a developer can identify a UI point without switching
 * away from the app being inspected.
 */
object DevPilotOverlayManager {
    private const val prefsName = "devpilot.overlay"
    private const val selectedXKey = "selectedX"
    private const val selectedYKey = "selectedY"
    private const val instructionKey = "instruction"
    private const val selectedAtKey = "selectedAt"

    private var windowManager: WindowManager? = null
    private var rootView: View? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private var selectionDispatcher: ((Map<String, Any>) -> Unit)? = null

    fun setSelectionDispatcher(dispatcher: (Map<String, Any>) -> Unit) {
        selectionDispatcher = dispatcher
    }

    fun isVisible(): Boolean = rootView != null

    fun show(context: Context) {
        if (rootView != null) return
        windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        showCollapsed(context)
    }

    fun hide() {
        val manager = windowManager
        val view = rootView
        if (manager != null && view != null) {
            runCatching { manager.removeView(view) }
        }
        rootView = null
        layoutParams = null
        windowManager = null
    }

    fun consumeSelection(context: Context): Map<String, Any>? {
        val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        if (!prefs.contains(selectedAtKey)) return null
        val selection = mapOf(
            "x" to prefs.getFloat(selectedXKey, 0f).toDouble(),
            "y" to prefs.getFloat(selectedYKey, 0f).toDouble(),
            "instruction" to prefs.getString(instructionKey, "")!!,
            "selectedAt" to prefs.getLong(selectedAtKey, 0L),
        )
        prefs.edit().clear().apply()
        return selection
    }

    private fun showCollapsed(context: Context) {
        removeCurrent()
        val button = TextView(context).apply {
            text = "DP"
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            background = pill(Color.rgb(37, 117, 255), 56)
            elevation = dp(context, 8).toFloat()
            contentDescription = "DevPilotの画面修正パネルを開く"
            setOnClickListener { showPanel(context) }
        }
        attach(context, button, 56, 56, focusable = false)
    }

    private fun showPanel(context: Context, selection: Pair<Float, Float>? = null) {
        removeCurrent()
        val panel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
            background = pill(Color.rgb(14, 23, 39), 18, Color.rgb(45, 111, 224))
        }
        panel.addView(label(context, "DevPilot  Point & Fix", 16, Color.WHITE))
        panel.addView(label(
            context,
            selection?.let { "選択位置: ${it.first.toInt()} × ${it.second.toInt()}" }
                ?: "hamolo上の修正したい場所を選択します",
            12,
            Color.rgb(183, 202, 235),
        ), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(context, 5) })

        val select = Button(context).apply {
            text = if (selection == null) "画面上の場所を選択" else "選び直す"
            setOnClickListener { startPointSelection(context) }
        }
        panel.addView(select, LinearLayout.LayoutParams(-1, dp(context, 44)).apply { topMargin = dp(context, 10) })

        if (selection != null) {
            val input = EditText(context).apply {
                hint = "例: このボタンを大きくしたい"
                setHintTextColor(Color.rgb(145, 163, 193))
                setTextColor(Color.WHITE)
                setSingleLine(false)
                minLines = 2
                background = pill(Color.rgb(7, 13, 24), 9, Color.rgb(47, 101, 184))
                setPadding(dp(context, 10), dp(context, 6), dp(context, 10), dp(context, 6))
            }
            panel.addView(input, LinearLayout.LayoutParams(-1, dp(context, 72)).apply { topMargin = dp(context, 8) })
            val submit = Button(context).apply {
                text = "修正指示をDevPilotへ渡す"
                setOnClickListener {
                    val instruction = input.text.toString().trim()
                    if (instruction.isEmpty()) {
                        input.error = "修正内容を入力してください"
                        return@setOnClickListener
                    }
                    context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit()
                        .putFloat(selectedXKey, selection.first)
                        .putFloat(selectedYKey, selection.second)
                        .putString(instructionKey, instruction)
                        .putLong(selectedAtKey, System.currentTimeMillis())
                        .apply()
                    removeCurrent()
                    selectionDispatcher?.invoke(
                        mapOf(
                            "x" to selection.first.toDouble(),
                            "y" to selection.second.toDouble(),
                            "instruction" to instruction,
                            "selectedAt" to System.currentTimeMillis(),
                        ),
                    )
                    Toast.makeText(context, "修正指示をDevPilotへ渡しました", Toast.LENGTH_SHORT).show()
                    // Give the Agent a brief overlay-free window to capture
                    // the inspected app rather than the DP control itself.
                    Handler(Looper.getMainLooper()).postDelayed(
                        { showCollapsed(context) },
                        500,
                    )
                }
            }
            panel.addView(submit, LinearLayout.LayoutParams(-1, dp(context, 46)).apply { topMargin = dp(context, 8) })
        }

        val close = TextView(context).apply {
            text = "閉じる"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(184, 204, 239))
            setPadding(0, dp(context, 10), 0, 0)
            setOnClickListener { hide() }
        }
        panel.addView(close, LinearLayout.LayoutParams(-1, dp(context, 34)))
        attach(context, panel, 300, WindowManager.LayoutParams.WRAP_CONTENT, focusable = selection != null)
    }

    private fun startPointSelection(context: Context) {
        removeCurrent()
        val selector = TextView(context).apply {
            text = "修正したい場所を1回タップしてください"
            textSize = 15f
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            setTextColor(Color.WHITE)
            setPadding(dp(context, 20), dp(context, 48), dp(context, 20), 0)
            setBackgroundColor(0x22000000)
            setOnTouchListener { _, event ->
                if (event.action == MotionEvent.ACTION_UP) {
                    showPanel(context, Pair(event.rawX, event.rawY))
                }
                true
            }
        }
        attach(
            context,
            selector,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            focusable = true,
        )
    }

    private fun attach(context: Context, view: View, widthDp: Int, heightDp: Int, focusable: Boolean) {
        val width = if (widthDp == WindowManager.LayoutParams.MATCH_PARENT) widthDp else dp(context, widthDp)
        val height = if (heightDp == WindowManager.LayoutParams.MATCH_PARENT) heightDp else dp(context, heightDp)
        val flags = if (focusable) {
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        } else {
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        }
        val params = WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            flags,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = dp(context, 14)
            y = dp(context, 140)
        }
        windowManager?.addView(view, params)
        rootView = view
        layoutParams = params
    }

    private fun removeCurrent() {
        val manager = windowManager
        val view = rootView
        if (manager != null && view != null) runCatching { manager.removeView(view) }
        rootView = null
        layoutParams = null
    }

    private fun label(context: Context, value: String, size: Int, color: Int) = TextView(context).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
    }

    private fun pill(color: Int, radiusDp: Int, strokeColor: Int? = null) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radiusDp * 3f
        if (strokeColor != null) setStroke(2, strokeColor)
    }

    private fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()
}
