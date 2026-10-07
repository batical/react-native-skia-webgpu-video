package com.skiawebgpuvideo.tests

import android.os.Bundle
import android.content.Intent
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  companion object { @Volatile var benchmarkIntent: Intent? = null }
  override fun getMainComponentName() = "ReactNativeSkiaWebGPUVideoExample"
  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
  override fun onCreate(savedInstanceState: Bundle?) {
    benchmarkIntent = intent
    if (intent.getStringExtra("RNSKV_BENCHMARK_PROFILE") in listOf("smoke", "full", "soak")) {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    super.onCreate(null)
  }
}
