package ai.openclaw.app.anylink

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

@Composable
internal fun OverlayTransparencyControl(opacity: Float, onOpacityChange: (Float) -> Unit) {
  val transparency = ((1f - opacity) * 100f).coerceIn(0f, 80f)
  Column {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text("悬浮窗透明度", color = MaterialTheme.colorScheme.onSurface)
      Text("${transparency.roundToInt()}%", color = MaterialTheme.colorScheme.primary)
    }
    Slider(
      value = transparency, onValueChange = { onOpacityChange(1f - it / 100f) },
      valueRange = 0f..80f, steps = 15,
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "悬浮窗透明度" },
    )
    Text("左侧更清晰，右侧更透明；调整后自动保存。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(4.dp))
  }
}
