package ai.openclaw.app.anylink

import ai.openclaw.app.R
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource

/** Generated VectorDrawables share their path data with the SVG icon directory. */
internal enum class AppIcon(val resource: Int) {
  Mic(R.drawable.anylink_ic_mic), MicOff(R.drawable.anylink_ic_mic_off),
  Phone(R.drawable.anylink_ic_phone), HangUp(R.drawable.anylink_ic_phone_off),
  Speaker(R.drawable.anylink_ic_speaker), Earpiece(R.drawable.anylink_ic_earpiece),
  Attachment(R.drawable.anylink_ic_attachment), File(R.drawable.anylink_ic_file),
  Image(R.drawable.anylink_ic_image), Play(R.drawable.anylink_ic_play),
  Share(R.drawable.anylink_ic_share), Close(R.drawable.anylink_ic_close),
  Stop(R.drawable.anylink_ic_stop), Send(R.drawable.anylink_ic_send),
  Settings(R.drawable.anylink_ic_settings), Tasks(R.drawable.anylink_ic_tasks),
  Chevron(R.drawable.anylink_ic_chevron), Check(R.drawable.anylink_ic_check),
}
@Composable
internal fun AppIcon(icon: AppIcon, description: String? = null, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) {
  Icon(painterResource(icon.resource), contentDescription = description, modifier = modifier, tint = tint)
}
