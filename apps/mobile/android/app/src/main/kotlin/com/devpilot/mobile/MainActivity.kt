package com.devpilot.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val overlayChannel = "devpilot/overlay"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val overlayMethods = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, overlayChannel)
        DevPilotOverlayManager.setSelectionDispatcher { selection ->
            overlayMethods.invokeMethod("selection", selection)
        }
        overlayMethods
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "status" -> result.success(
                        mapOf(
                            "permissionGranted" to canDrawOverlays(),
                            "visible" to DevPilotOverlayManager.isVisible(),
                        ),
                    )
                    "requestPermission" -> {
                        if (!canDrawOverlays()) {
                            startActivity(
                                Intent(
                                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:$packageName"),
                                ),
                            )
                        }
                        result.success(canDrawOverlays())
                    }
                    "show" -> {
                        if (!canDrawOverlays()) {
                            result.success(false)
                        } else {
                            DevPilotOverlayManager.show(applicationContext)
                            result.success(true)
                        }
                    }
                    "hide" -> {
                        DevPilotOverlayManager.hide()
                        result.success(true)
                    }
                    "consumeSelection" -> result.success(
                        DevPilotOverlayManager.consumeSelection(applicationContext),
                    )
                    else -> result.notImplemented()
                }
            }
    }

    private fun canDrawOverlays(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
}
