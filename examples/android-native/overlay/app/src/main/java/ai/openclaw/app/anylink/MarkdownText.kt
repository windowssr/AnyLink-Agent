package ai.openclaw.app.anylink

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal sealed interface MarkdownBlock {
  data class Heading(val level: Int, val text: String) : MarkdownBlock
  data class Paragraph(val text: String) : MarkdownBlock
  data class CodeBlock(val language: String, val code: String) : MarkdownBlock
  data class BulletItem(val text: String, val indent: Int = 0) : MarkdownBlock
  data class OrderedItem(val number: String, val text: String, val indent: Int = 0) : MarkdownBlock
  data class Quote(val text: String) : MarkdownBlock
  data class Table(val headers: List<String>, val rows: List<List<String>>) : MarkdownBlock
  object Rule : MarkdownBlock
}

private val headingRegex = Regex("^\\s{0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$")
private val ruleRegex = Regex("^\\s{0,3}(?:[-*_]\\s*){3,}$")
private val bulletRegex = Regex("^(\\s*)[-*+]\\s+(.+)$")
private val orderedRegex = Regex("^(\\s*)(\\d{1,3})[.)]\\s+(.+)$")
private val tableSepRegex = Regex("^\\s*\\|?[\\s:|-]+\\|?\\s*$")

private fun splitTableRow(line: String): List<String> =
  line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

internal fun parseMarkdownBlocks(raw: String): List<MarkdownBlock> {
  val lines = raw.replace("\r\n", "\n").replace('\r', '\n').split('\n')
  val blocks = mutableListOf<MarkdownBlock>()
  var i = 0
  while (i < lines.size) {
    val line = lines[i]
    val trimmed = line.trim()
    if (trimmed.isEmpty()) {
      i++
      continue
    }
    // Fenced code block (``` or ~~~), streaming-safe even when closing fence hasn't arrived yet.
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      val fence = if (trimmed.startsWith("```")) "```" else "~~~"
      val lang = trimmed.removePrefix(fence).trim()
      val codeLines = mutableListOf<String>()
      i++
      while (i < lines.size && !lines[i].trim().startsWith(fence)) {
        codeLines += lines[i]
        i++
      }
      if (i < lines.size) i++ // consume closing fence if present
      blocks += MarkdownBlock.CodeBlock(lang, codeLines.joinToString("\n"))
      continue
    }
    // Horizontal rule
    if (ruleRegex.matches(line)) {
      blocks += MarkdownBlock.Rule
      i++
      continue
    }
    // Heading
    headingRegex.matchEntire(line)?.let { m ->
      blocks += MarkdownBlock.Heading(m.groupValues[1].length, m.groupValues[2].trim())
      i++
      continue
    }
    // Blockquote (group consecutive > lines)
    if (trimmed.startsWith(">")) {
      val quoteLines = mutableListOf<String>()
      while (i < lines.size && lines[i].trim().startsWith(">")) {
        quoteLines += lines[i].trim().removePrefix(">").removePrefix(" ")
        i++
      }
      blocks += MarkdownBlock.Quote(quoteLines.joinToString("\n").trim())
      continue
    }
    // Markdown table (header row + separator row)
    if (trimmed.contains("|") && i + 1 < lines.size && tableSepRegex.matches(lines[i + 1]) && lines[i + 1].contains('-')) {
      val headers = splitTableRow(line)
      i += 2
      val rows = mutableListOf<List<String>>()
      while (i < lines.size && lines[i].trim().isNotEmpty() && lines[i].contains("|")) {
        rows += splitTableRow(lines[i])
        i++
      }
      blocks += MarkdownBlock.Table(headers, rows)
      continue
    }
    // Unordered list item
    bulletRegex.matchEntire(line)?.let { m ->
      blocks += MarkdownBlock.BulletItem(m.groupValues[2].trim(), indent = (m.groupValues[1].length / 2).coerceAtMost(3))
      i++
      continue
    }
    // Ordered list item
    orderedRegex.matchEntire(line)?.let { m ->
      blocks += MarkdownBlock.OrderedItem(m.groupValues[2], m.groupValues[3].trim(), indent = (m.groupValues[1].length / 2).coerceAtMost(3))
      i++
      continue
    }
    // Paragraph (group consecutive plain lines)
    val para = mutableListOf<String>()
    while (i < lines.size) {
      val cur = lines[i]
      val ct = cur.trim()
      if (ct.isEmpty() || ct.startsWith("```") || ct.startsWith("~~~") || ct.startsWith(">") ||
        ruleRegex.matches(cur) || headingRegex.matches(cur) || bulletRegex.matches(cur) || orderedRegex.matches(cur) ||
        (ct.contains("|") && i + 1 < lines.size && tableSepRegex.matches(lines[i + 1]) && lines[i + 1].contains('-'))
      ) break
      para += cur
      i++
    }
    if (para.isNotEmpty()) blocks += MarkdownBlock.Paragraph(para.joinToString("\n"))
  }
  return blocks
}

internal fun parseInlineMarkdown(
  raw: String,
  codeBg: Color = Color(0xFFE3F2FB),
  codeFg: Color = Color(0xFF0E5A8A),
  linkColor: Color = Color(0xFF1368A0),
): AnnotatedString = buildAnnotatedString {
  var i = 0
  val n = raw.length
  while (i < n) {
    // Escaped markdown punctuation (\*, \`, \_, \[)
    if (raw[i] == '\\' && i + 1 < n && raw[i + 1] in "*_`~[]()\\#>-|") {
      append(raw[i + 1])
      i += 2
      continue
    }
    // Inline code `...`
    if (raw[i] == '`') {
      val end = raw.indexOf('`', i + 1)
      if (end > i + 1) {
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, color = codeFg, fontSize = 12.5.sp)) {
          append(" ${raw.substring(i + 1, end)} ")
        }
        i = end + 1
        continue
      }
    }
    // Markdown link [label](url)
    if (raw[i] == '[') {
      val closeBracket = raw.indexOf(']', i + 1)
      if (closeBracket > i + 1 && closeBracket + 1 < n && raw[closeBracket + 1] == '(') {
        val closeParen = raw.indexOf(')', closeBracket + 2)
        if (closeParen > closeBracket + 2) {
          val label = raw.substring(i + 1, closeBracket)
          val url = raw.substring(closeBracket + 2, closeParen).trim()
          if (url.startsWith("http://") || url.startsWith("https://")) {
            withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline, fontWeight = FontWeight.Medium)))) {
              append(label)
            }
          } else {
            withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) {
              append(label)
            }
          }
          i = closeParen + 1
          continue
        }
      }
    }
    // Bold + italic ***...***
    if (raw.startsWith("***", i)) {
      val end = raw.indexOf("***", i + 3)
      if (end > i + 3) {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic)) {
          append(parseInlineMarkdown(raw.substring(i + 3, end), codeBg, codeFg, linkColor))
        }
        i = end + 3
        continue
      }
    }
    // Bold **...** or __...__
    if (raw.startsWith("**", i) || raw.startsWith("__", i)) {
      val delim = raw.substring(i, i + 2)
      val end = raw.indexOf(delim, i + 2)
      if (end > i + 2) {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
          append(parseInlineMarkdown(raw.substring(i + 2, end), codeBg, codeFg, linkColor))
        }
        i = end + 2
        continue
      }
    }
    // Strikethrough ~~...~~
    if (raw.startsWith("~~", i)) {
      val end = raw.indexOf("~~", i + 2)
      if (end > i + 2) {
        withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
          append(parseInlineMarkdown(raw.substring(i + 2, end), codeBg, codeFg, linkColor))
        }
        i = end + 2
        continue
      }
    }
    // Italic *...* (avoid matching stray spaces like "2 * 3")
    if (raw[i] == '*' && i + 1 < n && !raw[i + 1].isWhitespace()) {
      val end = raw.indexOf('*', i + 1)
      if (end > i + 1 && !raw[end - 1].isWhitespace()) {
        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
          append(parseInlineMarkdown(raw.substring(i + 1, end), codeBg, codeFg, linkColor))
        }
        i = end + 1
        continue
      }
    }
    append(raw[i])
    i++
  }
}

@Composable
internal fun MarkdownText(
  text: String,
  color: Color,
  modifier: Modifier = Modifier,
  baseStyle: TextStyle = MaterialTheme.typography.bodyMedium,
  codeBg: Color = Color(0xFFE3F2FB),
  codeFg: Color = Color(0xFF0E5A8A),
  linkColor: Color = Color(0xFF1368A0),
  quoteAccent: Color = Color(0xFF2D95CF),
  quoteBg: Color = Color(0xFFEEF7FD),
) {
  val blocks = remember(text) { parseMarkdownBlocks(text) }
  if (blocks.isEmpty()) {
    Text(text = text, style = baseStyle, color = color, lineHeight = 21.sp, modifier = modifier)
    return
  }
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
    for (block in blocks) {
      when (block) {
        is MarkdownBlock.Heading -> {
          val size = when (block.level) {
            1 -> 18.sp
            2 -> 16.5.sp
            3 -> 15.sp
            else -> 14.sp
          }
          Text(
            text = remember(block.text) { parseInlineMarkdown(block.text, codeBg, codeFg, linkColor) },
            fontSize = size,
            fontWeight = FontWeight.Bold,
            color = color,
            lineHeight = (size.value + 6f).sp,
            modifier = Modifier.padding(top = 2.dp),
          )
        }
        is MarkdownBlock.Paragraph -> {
          Text(
            text = remember(block.text) { parseInlineMarkdown(block.text, codeBg, codeFg, linkColor) },
            style = baseStyle,
            color = color,
            lineHeight = 21.sp,
          )
        }
        is MarkdownBlock.BulletItem -> {
          Row(Modifier.fillMaxWidth().padding(start = (block.indent * 12).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("•", style = baseStyle, fontWeight = FontWeight.Bold, color = linkColor, lineHeight = 21.sp)
            Text(
              text = remember(block.text) { parseInlineMarkdown(block.text, codeBg, codeFg, linkColor) },
              style = baseStyle,
              color = color,
              lineHeight = 21.sp,
              modifier = Modifier.weight(1f),
            )
          }
        }
        is MarkdownBlock.OrderedItem -> {
          Row(Modifier.fillMaxWidth().padding(start = (block.indent * 12).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${block.number}.", style = baseStyle, fontWeight = FontWeight.SemiBold, color = linkColor, lineHeight = 21.sp)
            Text(
              text = remember(block.text) { parseInlineMarkdown(block.text, codeBg, codeFg, linkColor) },
              style = baseStyle,
              color = color,
              lineHeight = 21.sp,
              modifier = Modifier.weight(1f),
            )
          }
        }
        is MarkdownBlock.Quote -> {
          Row(
            Modifier
              .fillMaxWidth()
              .clip(RoundedCornerShape(10.dp))
              .background(quoteBg)
              .padding(vertical = 6.dp, horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Box(Modifier.width(3.dp).heightIn(min = 18.dp).clip(RoundedCornerShape(2.dp)).background(quoteAccent))
            Text(
              text = remember(block.text) { parseInlineMarkdown(block.text, codeBg, codeFg, linkColor) },
              style = baseStyle,
              color = color.copy(alpha = 0.85f),
              lineHeight = 20.sp,
              modifier = Modifier.weight(1f),
            )
          }
        }
        is MarkdownBlock.CodeBlock -> {
          Surface(
            color = Color(0xFFEAF4FB),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Color(0xFFC2E1F4)),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
              if (block.language.isNotBlank()) {
                Text(block.language.lowercase(), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF426A82))
              }
              Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                Text(
                  text = block.code,
                  fontFamily = FontFamily.Monospace,
                  fontSize = 12.sp,
                  lineHeight = 17.sp,
                  color = Color(0xFF0B2A40),
                )
              }
            }
          }
        }
        is MarkdownBlock.Table -> {
          Surface(
            color = Color(0xFFF3FAFF),
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, Color(0xFFC5E3F5)),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Column(Modifier.horizontalScroll(rememberScrollState()).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
              Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (h in block.headers) {
                  Text(
                    text = remember(h) { parseInlineMarkdown(h, codeBg, codeFg, linkColor) },
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = color,
                    modifier = Modifier.widthIn(min = 64.dp, max = 160.dp),
                  )
                }
              }
              HorizontalDivider(color = Color(0xFFC5E3F5))
              for (row in block.rows) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                  for (cell in row) {
                    Text(
                      text = remember(cell) { parseInlineMarkdown(cell, codeBg, codeFg, linkColor) },
                      fontSize = 12.sp,
                      color = color,
                      modifier = Modifier.widthIn(min = 64.dp, max = 160.dp),
                    )
                  }
                }
              }
            }
          }
        }
        MarkdownBlock.Rule -> HorizontalDivider(color = Color(0xFFCCE6F6))
      }
    }
  }
}
